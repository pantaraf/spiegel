'use strict'

const Throttler = require('squadron').Throttler
const log = require('./log')
const sporks = require('sporks')
const url = require('url')

class Replicators {
  constructor (spiegel, opts) {
    this._spiegel = spiegel
    this._slouch = spiegel._slouch

    this._throttler = new Throttler(
      opts && opts.maxConcurrentReplicatorProcesses
        ? opts.maxConcurrentReplicatorProcesses
        : undefined
    )

    this._passwords = opts && opts.replicatorPasswords ? opts.replicatorPasswords : {}

    // WARNING: retryAfterSeconds must be less than the maximum time it takes to perform the
    // replication or else there can be concurrent replications for the same DB that will backup the
    // replication queue and continuously run
    this._retryAfterSeconds = opts && opts.retryAfterSeconds ? opts.retryAfterSeconds : 10800

    // "continuous" is added here as we do not want the continuous parameter to be passed to CouchDB
    // or else the replication will block indefinitely. "cancel" is needed as it does not apply and
    // would lead to unintended behavior
    this._spiegelReplicationParams = [
      'type',
      'dirty',
      'locked_at',
      'updated_at',
      'continuous',
      'cancel'
    ]
  }

  _createDirtyReplicatorsView () {
    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, {
      _id: '_design/dirty_replicators',
      views: {
        dirty_replicators: {
          map: [
            'function(doc) {',
            'if (doc.type === "replicator" && doc.dirty) {',
            'emit(doc._id, null);',
            '}',
            '}'
          ].join(' ')
        }
      }
    })
  }

  _createCleanOrLockedReplicatorsByDBNameView () {
    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, {
      _id: '_design/clean_or_locked_replicators_by_db_name',
      views: {
        clean_or_locked_replicators_by_db_name: {
          // See _toDBName for how the DB name is extracted from the source
          map: [
            'function(doc) {',
            'if (doc.type === "replicator" && doc.source && (!doc.dirty || doc.locked_at)) {',
            'var i = doc.source.lastIndexOf("/");',
            'if (i !== -1) {',
            'emit(doc.source.substr(i + 1), null);',
            '}',
            '}',
            '}'
          ].join(' ')
        }
      }
    })
  }

  _createDirtyAndUnLockedReplicatorsView () {
    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, {
      _id: '_design/dirty_and_unlocked_replicators',
      views: {
        dirty_and_unlocked_replicators: {
          map: [
            'function(doc) {',
            'if (doc.type === "replicator" && doc.dirty && !doc.locked_at)) {',
            'emit(doc._id, null);',
            '}',
            '}'
          ].join(' ')
        }
      }
    })
  }

  // TODO: still needed or does clean_or_locked_replicators_by_db_name replace need for this view?
  _createCleanReplicatorsView () {
    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, {
      _id: '_design/clean_replicators',
      views: {
        clean_replicators: {
          map: [
            'function(doc) {',
            'if (doc.type === "replicator" && !doc.dirty) {',
            'emit(doc._id, null);',
            '}',
            '}'
          ].join(' ')
        }
      }
    })
  }

  _createReplicatorsByDBNameView () {
    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, {
      _id: '_design/replicators_by_db_name',
      views: {
        replicators_by_db_name: {
          map: [
            'function(doc) {',
            'if (doc.type === "replicator") {',
            'emit(doc.db_name, null);',
            '}',
            '}'
          ].join(' ')
        }
      }
    })
  }

  async _createViews () {
    await this._createDirtyReplicatorsView()
    await this._createCleanOrLockedReplicatorsByDBNameView()
    await this._createDirtyAndUnLockedReplicatorsView()
    await this._createCleanReplicatorsView()
    await this._createReplicatorsByDBNameView()
  }

  create () {
    return this._createViews()
  }

  async _destroyViews () {
    await this._slouch.doc.getAndDestroy(this._spiegel._dbName, '_design/dirty_replicators')
    await this._slouch.doc.getAndDestroy(
      this._spiegel._dbName,
      '_design/clean_or_locked_replicators_by_db_name'
    )
    await this._slouch.doc.getAndDestroy(
      this._spiegel._dbName,
      '_design/dirty_and_unlocked_replicators'
    )
    await this._slouch.doc.getAndDestroy(this._spiegel._dbName, '_design/clean_replicators')
    await this._slouch.doc.getAndDestroy(this._spiegel._dbName, '_design/replicators_by_db_name')
  }

  destroy () {
    return this._destroyViews()
  }

  _get (id) {
    return this._slouch.doc.get(this._spiegel._dbName, id)
  }

  async _getCleanOrLocked (dbNames) {
    let response = await this._slouch.db.viewArray(
      this._spiegel._dbName,
      '_design/clean_or_locked_replicators_by_db_name',
      'clean_or_locked_replicators_by_db_name',
      { include_docs: true, keys: JSON.stringify(dbNames) }
    )

    return response.rows.map(row => row.doc)
  }

  // Useful for determining the last time a replicator was used
  _setUpdatedAt (listener) {
    listener.updated_at = new Date().toISOString()
  }

  _dirty (replicators) {
    replicators.forEach(replicator => {
      replicator.dirty = true
      this._setUpdatedAt(replicator)
    })

    return this._slouch.doc.bulkCreateOrUpdate(this._spiegel._dbName, replicators)
  }

  _toDBName (source) {
    if (source) {
      var i = source.lastIndexOf('/')
      if (i !== -1) {
        return source.substr(i + 1)
      }
    }
  }

  async _dirtyAndGetConflictedDBNames (replicators) {
    let response = await this._dirty(replicators)

    // Get a list of all the dbNames where we have conflicts. This can occur because the replicator
    // was dirtied, locked or otherwise updated between the _getCleanOrLocked() and _dirty() calls
    // above.
    var conflictedDBNames = []
    response.forEach((doc, i) => {
      if (this._slouch.doc.isConflictError(doc)) {
        conflictedDBNames.push(this._toDBName(replicators[i].source))
      }
    })

    return conflictedDBNames
  }

  async _attemptToDirtyIfCleanOrLocked (dbNames) {
    let replicators = await this._getCleanOrLocked(dbNames)

    // length can be zero if there is nothing to dirty
    if (replicators.length > 0) {
      return this._dirtyAndGetConflictedDBNames(replicators)
    }
  }

  // We need to dirty replicators so that the replication can be delegated to a replicator process.
  //
  // We use bulk operations as this is far faster than processing each replicator individually. With
  // bulk operations we can take a batch of updates and in just a few requests to CouchDB schedule
  // the delegation and then move on to the next set of updates. In addition, processing updates in
  // a batch allows us to remove duplicates in that batch that often occur due to back-to-back
  // writes to a particular DB.
  //
  // When dirtying the replicators we first get a list of all the clean or locked replicators. We
  // need to include the locked replicators as we may already be performing a replication, hence the
  // lock, and we want to make sure to re-dirty the replicator so that the revision number changes.
  // This will then result in the replication being retried later.
  //
  // Between the time the clean or locked replicators are retrieved and then dirtied, it is possible
  // that another UpdateListener dirties the same replicator. In this event, we'll detect the
  // conflicts. We'll then retry the get and dirty for these conflicted replicators. We'll repeat
  // this process until there are no more conflicts.
  async dirtyIfCleanOrLocked (dbNames) {
    let conflictedDBNames = await this._attemptToDirtyIfCleanOrLocked(dbNames)
    if (conflictedDBNames && conflictedDBNames.length > 0) {
      return this.dirtyIfCleanOrLocked(conflictedDBNames)
    }
  }

  async _getLastSeq () {
    let lastSeq = null
    await this._spiegel._slouch.db
      .changes(this._spiegel._dbName, {
        limit: 1,
        descending: true,
        filter: '_view',
        view: 'dirty_and_unlocked_replicators'
      })
      .each(change => {
        lastSeq = change.seq
      })
    return lastSeq
  }

  _update (replicator) {
    return this._slouch.doc.update(this._spiegel._dbName, replicator)
  }

  async lock (replicator) {
    // We use an update instead of an upsert as we want there to be a conflict as we only want one
    // process to hold the lock at any given time
    let lockedReplicator = sporks.clone(replicator)
    lockedReplicator.locked_at = new Date().toISOString()
    this._setUpdatedAt(lockedReplicator)
    let response = await this._update(lockedReplicator)
    lockedReplicator._rev = response._rev
    return lockedReplicator
  }

  async _lockAndThrowIfErrorAndNotConflict (replicator) {
    try {
      await this._lock(replicator)
    } catch (err) {
      if (this._slouch.doc.isConflictError(err)) {
        log.trace('Ignoring common conflict', err)
        return true
      } else {
        throw err
      }
    }
  }

  _toCouchDBReplicationParams (params) {
    // We choose to blacklist as oppossed to whitelist so that any future CouchDB replication
    // parameters will work without Spiegel being updated
    let couchParams = {}
    sporks.each(params, (value, name) => {
      // Is the param for CouchDB?
      if (this._spiegelReplicationParams.indexOf(name) === -1) {
        couchParams[name] = value
      }
    })
    return couchParams
  }

  _addPassword (urlString) {
    if (this._passwords) {
      let parts = url.parse(urlString)

      // Was a password defined?
      if (this._passwords[parts.hostname] && this._passwords[parts.hostname][parts.auth]) {
        let password = this._passwords[parts.hostname][parts.auth]
        return (
          parts.protocol + '//' + parts.auth + ':' + password + '@' + parts.host + parts.pathname
        )
      }
    }

    return urlString
  }

  async _replicate (replicator) {
    let couchParams = this._toCouchDBReplicationParams(replicator)

    log.info('Beginning replication from', replicator.source, 'to', replicator.target)

    // Add passwords to URLs based on hostname and username so that passwords are not embedded in
    // the replicator docs
    couchParams.source = this._addPassword(couchParams.source)
    couchParams.target = this._addPassword(couchParams.target)

    await this._slouch.db.replicate(couchParams)

    log.info('Finished replication from', replicator.source, 'to', replicator.target)
  }

  async _lockReplicateUnlock (replicator) {
    // Lock and if conflict then ignore error as conflicts are expected when another replicator
    // process locks the same replicator

    let conflict = await this._lockAndThrowIfErrorAndNotConflict(replicator)

    if (!conflict) {
      // TODO: if an error is encountered when replicating then leave the replicator dirty, but
      // unlock it so that the replication can be tried again
      await this._replicate(replicator)

      // TODO:
      // 3. Unlock & set clean
      //   - if conflict then don't change dirty status and just unlock - upsert
    }
  }

  async _replicateAllDirtyAndUnlocked () {
    let iterator = this._changes({
      filter: '_view',
      view: 'dirty_and_unlocked_replicators'
    })
    await iterator.each(replicator => {
      return this._lockReplicateUnlock(replicator)
    }, this._throttler)
  }

  async _listen (lastSeq) {
    this._iterator = this._changes({
      feed: 'continuous',
      heartbeat: true,
      since: lastSeq,
      filter: '_view',
      view: 'dirty_and_unlocked_replicators'
    })

    this._iterator.on('error', err => {
      // Unexpected error. Errors should be handled at the Slouch layer and connections should be
      // persistent
      log.error(err)
    })

    this._iterator.each(replicator => {
      return this._lockReplicateUnlock(replicator)
    }, this._throttler)
  }

  async start () {
    // Get the last seq so that we can use this as the starting point when listening for changes
    let lastSeq = await this._getLastSeq

    // Get all dirty replicators and then perform the replications concurrently
    await this._replicateAllDirtyAndUnlocked()

    // Listen for changes. We don't await here as the listening is a continuous operation
    this._listen(lastSeq)
  }

  async stop () {
    this._stopped = true
    if (this._iterator) {
      await this._iterator.allDone()
    }
  }
}

module.exports = Replicators
