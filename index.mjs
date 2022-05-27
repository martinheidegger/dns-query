import * as packet from '@leichtgewicht/dns-packet'
import * as lib from 'dns-query/lib.js'
import { lookup as backup } from 'dns-query/resolvers.js'
import {
  AbortError,
  ResponseError,
  BaseEndpoint,
  parseEndpoint,
  URL,
  toEndpoint
} from 'dns-query/common.js'

export {
  TimeoutError,
  HTTPStatusError,
  AbortError,
  ResponseError,
  BaseEndpoint,
  HTTPEndpoint,
  UDP4Endpoint,
  UDP6Endpoint,
  parseEndpoint,
  toEndpoint
} from 'dns-query/common.js'

function queryOne (endpoint, query, timeout, abortSignal) {
  if (abortSignal && abortSignal.aborted) {
    return Promise.reject(new AbortError())
  }
  if (endpoint.protocol === 'udp4:' || endpoint.protocol === 'udp6:') {
    return lib.queryDns(endpoint, query, timeout, abortSignal)
  }
  return queryDoh(endpoint, query, timeout, abortSignal)
}

function queryDoh (endpoint, query, timeout, abortSignal) {
  return lib.request(
    endpoint.url,
    endpoint.method,
    packet.encode(Object.assign({
      flags: packet.RECURSION_DESIRED,
      type: 'query'
    }, query)),
    timeout,
    abortSignal
  ).then(
    function (res) {
      const data = res.data
      const response = res.response
      let error = res.error
      if (error === undefined) {
        if (data.length === 0) {
          error = new ResponseError('Empty.')
        } else {
          try {
            const decoded = packet.decode(data)
            decoded.endpoint = endpoint
            decoded.response = response
            return decoded
          } catch (err) {
            error = new ResponseError('Invalid packet (cause=' + err.message + ')', err)
          }
        }
      }
      throw Object.assign(error, { response, endpoint })
    },
    error => {
      throw Object.assign(error, { endpoint })
    }
  )
}

const UPDATE_URL = new URL('https://martinheidegger.github.io/dns-query/resolvers.json')

export class Session {
  constructor (opts) {
    this.opts = Object.assign({
      retries: 5,
      timeout: 30000, // 30 seconds
      update: true,
      updateURL: UPDATE_URL,
      persist: false,
      maxAge: 300000 // 5 minutes
    }, opts)
    this._wellknownP = null
  }

  _wellknown (force) {
    if (!force && this._wellknownP !== null) {
      return this._wellknownP.then(res => {
        if (res.time < Date.now() - this.opts.maxAge) {
          return this._wellknown(true)
        }
        return res
      })
    }
    this._wellknownP = (this.opts.update
      ? lib.loadJSON(
        this.opts.updateURL,
        this.opts.persist
          ? {
              name: 'resolvers.json',
              maxTime: Date.now() - this.opts.maxAge
            }
          : null,
        this.opts.timeout
      )
        .then(res => {
          const resolvers = res.data.resolvers.map(resolver => {
            resolver.endpoint = toEndpoint(Object.assign({ name: resolver.name }, resolver.endpoint))
            return resolver
          })
          const endpoints = resolvers.map(resolver => resolver.endpoint)
          return {
            data: {
              resolvers,
              resolverByName: resolvers.reduce((byName, resolver) => {
                byName[resolver.name] = resolver
                return byName
              }, {}),
              endpoints,
              endpointByName: endpoints.reduce((byName, endpoint) => {
                byName[endpoint.name] = endpoint
                return byName
              }, {})
            },
            time: res.time
          }
        })
        .catch(() => null)
      : Promise.resolve(null)
    )
      .then(res => res || {
        data: backup,
        time: null
      })
      .then(res => {
        const native = lib.nativeEndpoints()
        return {
          time: res.time === null ? Date.now() : res.time,
          data: Object.assign({}, res.data, {
            endpoints: res.data.endpoints.concat(native)
            // TODO: nativeEndpoints currently have no name, but they might have?
          })
        }
      })
    return this._wellknownP
  }

  wellknown () {
    return this._wellknown(false).then(data => data.data)
  }

  endpoints () {
    return this.wellknown().then(data => data.endpoints)
  }

  query (q, opts) {
    opts = Object.assign({}, this.opts, opts)
    return loadEndpoints(this, opts.endpoints)
      .then(endpoints => queryN(endpoints, q, opts))
  }
}

const defautSession = new Session()

export function query (q, opts) {
  return defautSession.query(q, opts)
}

export function endpoints () {
  return defautSession.endpoints()
}

export function wellknown () {
  return defautSession.wellknown()
}

function queryN (endpoints, q, opts) {
  if (endpoints.length === 0) {
    throw new Error('No endpoints defined.')
  }
  const endpoint = endpoints.length === 1
    ? endpoints[0]
    : endpoints[Math.floor(Math.random() * endpoints.length) % endpoints.length]
  return queryOne(endpoint, q, opts.timeout, opts.signal)
    .then(
      data => {
        // Add the endpoint to give a chance to identify which endpoint returned the result
        data.endpoint = endpoint
        return data
      },
      err => {
        if (err.name === 'AbortError' || opts.retries === 0) {
          throw err
        }
        if (opts.retries > 0) {
          opts.retries -= 1
        }
        return query(q, opts)
      }
    )
}

function filterEndpoints (filter) {
  return function (endpoints) {
    const result = []
    for (const name in endpoints) {
      const endpoint = endpoints[name]
      if (filter(endpoint)) {
        result.push(endpoint)
      }
    }
    return result
  }
}

const filterDoh = filterEndpoints(function filterDoh (endpoint) {
  return endpoint.protocol === 'https:' || endpoint.protocol === 'http:'
})

const filterDns = filterEndpoints(function filterDns (endpoint) {
  return endpoint.protocol === 'udp4:' || endpoint.protocol === 'udp6:'
})

function isPromise (input) {
  if (input === null) {
    return false
  }
  if (typeof input !== 'object') {
    return false
  }
  return typeof input.then === 'function'
}

function isString (entry) {
  return typeof entry === 'string'
}

export function loadEndpoints (session, input) {
  const p = isPromise(input) ? input : Promise.resolve(input)
  return p.then(function (endpoints) {
    if (endpoints === 'doh') {
      return session.endpoints().then(filterDoh)
    }
    if (endpoints === 'dns') {
      return session.endpoints().then(filterDns)
    }
    const type = typeof endpoints
    if (type === 'function') {
      return session.endpoints().then(filterEndpoints(endpoints))
    }
    if (endpoints === null || endpoints === undefined || type === 'string' || typeof endpoints[Symbol.iterator] !== 'function') {
      throw new Error(`Endpoints (${endpoints}) needs to be iterable.`)
    }
    endpoints = Array.from(endpoints).filter(Boolean)
    if (endpoints.findIndex(isString) === -1) {
      return endpoints.map(endpoint => {
        if (endpoint instanceof BaseEndpoint) {
          return endpoint
        }
        return toEndpoint(endpoint)
      })
    }
    return session.wellknown()
      .then(wellknown =>
        endpoints.map(endpoint => {
          if (endpoint instanceof BaseEndpoint) {
            return endpoint
          }
          if (typeof endpoint === 'string') {
            return wellknown.endpointByName[endpoint] || parseEndpoint(endpoint)
          }
          return toEndpoint(endpoint)
        })
      )
  })
}