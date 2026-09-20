'use strict';

/**
 * Web Filtering Database API client for Node.js.
 *
 * Wraps the classification endpoint at
 * https://www.webfilteringdatabase.com/api/moderate.php:
 *
 *   POST moderate.php   query=<domain or URL>&data_type=url&api_key=<key>
 *
 * One call returns the domain's web filtering categories (59-category
 * taxonomy), its IAB content categories (tier 1 and the newer IAB taxonomy),
 * buyer personas, detected language and the remaining credit balance.
 * No runtime dependencies. Works on Node.js 14 and newer.
 */

const https = require('https');
const { URL } = require('url');
const querystring = require('querystring');

const DEFAULT_BASE_URL = 'https://www.webfilteringdatabase.com/api';
const DEFAULT_TIMEOUT = 45000;
const USER_AGENT = 'webfilteringdatabase-node/1.0.0 (+https://www.webfilteringdatabase.com)';

class WebFilteringError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'WebFilteringError';
    this.status = status;
    this.body = body;
  }
}
class AuthenticationError extends WebFilteringError {
  constructor(m, s, b) { super(m, s, b); this.name = 'AuthenticationError'; }
}
class ClassificationError extends WebFilteringError {
  constructor(m, s, b) { super(m, s, b); this.name = 'ClassificationError'; }
}
class RateLimitError extends WebFilteringError {
  constructor(m, s, b) { super(m, s, b); this.name = 'RateLimitError'; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep a full URL as given; reduce a bare host to lower case without a trailing dot. */
function normalizeQuery(input) {
  const s = String(input).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return s.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** Turn the API's ["Category name: X", "Confidence: 0.9"] pairs into {category, confidence}. */
function parsePairs(list) {
  if (!Array.isArray(list)) return [];
  return list.map((pair) => {
    const out = { category: null, confidence: null };
    (Array.isArray(pair) ? pair : [pair]).forEach((item) => {
      const s = String(item);
      if (/^Category name:/i.test(s)) out.category = s.replace(/^Category name:\s*/i, '').trim();
      else if (/^Confidence:/i.test(s)) out.confidence = parseFloat(s.replace(/^Confidence:\s*/i, ''));
    });
    return out;
  }).filter((c) => c.category);
}

/** One classification with parsed accessors; every raw field stays on the object. */
class Classification {
  constructor(query, data) {
    Object.assign(this, data);
    this.query = query;
    this.filtering = parsePairs(data.filtering_taxonomy);
    this.iab = parsePairs(data.iab_taxonomy);
    this.iabV2 = parsePairs(data.iab_taxonomy_version2);
  }
  /** Names of the web filtering categories, highest confidence first. */
  get filteringCategories() { return this.filtering.map((c) => c.category); }
  /** The single best web filtering category, or null when the site could not be classified. */
  get primaryFilteringCategory() { return this.filtering.length ? this.filtering[0].category : null; }
  get iabCategories() { return this.iab.map((c) => c.category); }
  get iabV2Categories() { return this.iabV2.map((c) => c.category); }
  get personas() { return Array.isArray(this.buyer_personas) ? this.buyer_personas : []; }
  get remainingCredits() { return typeof this.remaining_credits === 'number' ? this.remaining_credits : null; }
  /** True when any web filtering category matches one of the names given (case-insensitive). */
  inCategory(names) {
    const wanted = (Array.isArray(names) ? names : [names]).map((n) => String(n).toLowerCase());
    return this.filtering.some((c) => wanted.includes(c.category.toLowerCase()));
  }
}

class WebFilteringClient {
  /**
   * @param {string} apiKey   key from the account area at webfilteringdatabase.com
   * @param {object} [options]
   * @param {string} [options.baseUrl]     default https://www.webfilteringdatabase.com/api
   * @param {number} [options.timeout]     per-request timeout in ms, default 45000
   * @param {number} [options.maxRetries]  retries on network errors and 5xx, default 2
   */
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('apiKey is required');
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries === undefined ? 2 : options.maxRetries;
  }

  _raw(form) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.baseUrl + '/moderate.php');
      const body = querystring.stringify(form);
      const req = https.request(u, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': USER_AGENT,
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      });
      req.setTimeout(this.timeout, () => req.destroy(new Error('request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async _post(form) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let resp;
      try {
        resp = await this._raw(form);
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new WebFilteringError(`Request failed: ${err.message}`);
      }
      if (resp.status >= 500 && attempt < this.maxRetries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return WebFilteringClient._handle(resp);
    }
    throw new WebFilteringError(`Request failed after retries: ${lastErr && lastErr.message}`);
  }

  static _handle(resp) {
    let data;
    try { data = JSON.parse(resp.text); } catch (e) {
      throw new WebFilteringError(`Unexpected response: ${String(resp.text).slice(0, 200)}`, resp.status, resp.text);
    }
    const status = typeof data.status === 'number' ? data.status : resp.status;
    const msg = data.error || (typeof data.classification === 'string' ? data.classification : null) || `HTTP ${status}`;
    if (status === 401 || status === 403) throw new AuthenticationError(msg, status, data);
    if (status === 429) throw new RateLimitError(msg, status, data);
    if (status >= 400) throw new ClassificationError(msg, status, data);
    if (data.error) throw new ClassificationError(String(data.error), status, data);
    return data;
  }

  /** Classify one domain or URL. One credit. */
  async classify(domainOrUrl) {
    const query = normalizeQuery(domainOrUrl);
    const data = await this._post({ query, data_type: 'url', api_key: this.apiKey });
    return new Classification(query, data);
  }

  /** The best web filtering category for a domain, or null. */
  async category(domainOrUrl) {
    return (await this.classify(domainOrUrl)).primaryFilteringCategory;
  }

  /** True when the domain falls into any of the given web filtering categories. */
  async isInCategory(domainOrUrl, names) {
    return (await this.classify(domainOrUrl)).inCategory(names);
  }

  /**
   * Classify many domains with a small concurrency limit. Returns results in input
   * order; a failed lookup yields {query, error} instead of throwing.
   */
  async classifyMany(domains, options = {}) {
    const concurrency = Math.max(1, options.concurrency || 4);
    const pauseMs = options.pauseMs || 0;
    const inputs = Array.from(new Set(domains.map(normalizeQuery))).filter(Boolean);
    const out = new Array(inputs.length);
    let next = 0;
    const worker = async () => {
      while (next < inputs.length) {
        const i = next++;
        try {
          out[i] = await this.classify(inputs[i]);
        } catch (err) {
          if (err instanceof AuthenticationError) throw err;
          out[i] = { query: inputs[i], error: err.message, status: err.status || null };
        }
        if (pauseMs) await sleep(pauseMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
    return out;
  }
}

module.exports = WebFilteringClient;
module.exports.WebFilteringClient = WebFilteringClient;
module.exports.Classification = Classification;
module.exports.WebFilteringError = WebFilteringError;
module.exports.AuthenticationError = AuthenticationError;
module.exports.ClassificationError = ClassificationError;
module.exports.RateLimitError = RateLimitError;
module.exports.normalizeQuery = normalizeQuery;
module.exports.parsePairs = parsePairs;
