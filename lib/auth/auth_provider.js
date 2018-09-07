'use strict';

const MongoCredentials = require('./mongo_credentials').MongoCredentials;
const MongoError = require('../error').MongoError;
const Query = require('../connection/commands').Query;

/**
 * Creates a new Authentication mechanism
 * @class
 */
class AuthProvider {
  constructor(bson) {
    this.bson = bson;
    this.authStore = [];
  }

  _buildCommand(namespace, cmd) {
    return new Query(this.bson, namespace, cmd, {
      numberToSkip: 0,
      numberToReturn: 1
    });
  }

  /**
   * Authenticate
   * @method
   * @param {AuthWriteCommand} writeCommand Topology the authentication method is being called on
   * @param {Connection[]} connections Connections to authenticate using this authenticator
   * @param {string} source Name of the database
   * @param {string} username Username
   * @param {string} password Password
   * @param {object} mechanismProperties Properties for specific mechanisms like gssapi
   * @param {authResultCallback} callback The callback to return the result from the authentication
   * @return {object}
   */
  auth(writeCommand, connections, source, username, password, mechanismProperties, callback) {
    if (typeof mechanismProperties === 'function') {
      callback = mechanismProperties;
      mechanismProperties = undefined;
    }
    const credentials = new MongoCredentials({ username, password, source, mechanismProperties });
    return this._auth(writeCommand, connections, credentials, callback);
  }

  /**
   * Implementation of auth. Private method. expect this to go away once refactor is complete
   * @ignore
   */
  _auth(writeCommand, connections, credentials, callback) {
    // Total connections
    let count = connections.length;

    if (count === 0) {
      return callback(null, null);
    }

    // Valid connections
    let numberOfValidConnections = 0;
    let errorObject = null;

    const execute = connection => {
      this._authenticateSingleConnection(writeCommand, connection, credentials, (err, r) => {
        // Adjust count
        count = count - 1;

        // If we have an error
        if (err) {
          errorObject = err;
        } else if (r.result && r.result['$err']) {
          errorObject = r.result;
        } else if (r.result && r.result['errmsg']) {
          errorObject = r.result;
        } else {
          numberOfValidConnections = numberOfValidConnections + 1;
        }

        // Still authenticating against other connections.
        if (count !== 0) {
          return;
        }

        // We have authenticated all connections
        if (numberOfValidConnections > 0) {
          // Store the auth details
          this.addCredentials(credentials);
          // Return correct authentication
          callback(null, true);
        } else {
          if (errorObject == null) {
            errorObject = new MongoError(`failed to authenticate using ${credentials.mechanism}`);
          }
          callback(errorObject, false);
        }
      });
    };

    const executeInNextTick = _connection => process.nextTick(() => execute(_connection));

    // For each connection we need to authenticate
    while (connections.length > 0) {
      executeInNextTick(connections.shift());
    }
  }

  /**
   * Implementation of a single connection authenticating. Is meant to be overridden.
   * Will error if called directly
   * @ignore
   */
  _authenticateSingleConnection(/*writeCommand, connection, credentials, callback*/) {
    throw new Error('_authenticateSingleConnection must be overridden');
  }

  /**
   * Adds credentials to store only if it does not exist
   * @param {MongoCredentials} credentials credentials to add to store
   */
  addCredentials(credentials) {
    const found = this.authStore.some(cred => cred.equals(credentials));

    if (!found) {
      this.authStore.push(credentials);
    }
  }

  /**
   * Re authenticate pool
   * @method
   * @param {AuthWriteCommand} writeCommand Topology the authentication method is being called on
   * @param {Connection[]} connections Connections to authenticate using this authenticator
   * @param {authResultCallback} callback The callback to return the result from the authentication
   * @return {object}
   */
  reauthenticate(writeCommand, connections, callback) {
    const authStore = this.authStore.slice(0);
    let count = authStore.length;
    if (count === 0) {
      return callback(null, null);
    }

    for (let i = 0; i < authStore.length; i++) {
      this._auth(writeCommand, connections, authStore[i], function(err) {
        count = count - 1;
        if (count === 0) {
          callback(err, null);
        }
      });
    }
  }

  /**
   * Remove credentials that have been previously stored in the auth provider
   * @method
   * @param {string} source Name of database we are removing authStore details about
   * @return {object}
   */
  logout(source) {
    this.authStore = this.authStore.filter(credentials => credentials.source !== source);
  }
}

/**
 * A function that writes authentication commands to a specific connection
 * @callback AuthWriteCommand
 * @param {Connection} connection The connection to write to
 * @param {Command} command A command with a toBin method that can be written to a connection
 * @param {AuthWriteCallback} callback Callback called when command response is received
 */

/**
 * A callback for a specific auth command
 * @callback AuthWriteCallback
 * @param {Error} err If command failed, an error from the server
 * @param {object} r The response from the server
 */

/**
 * This is a result from an authentication strategy
 *
 * @callback authResultCallback
 * @param {error} error An error object. Set to null if no error present
 * @param {boolean} result The result of the authentication process
 */

module.exports = { AuthProvider };
