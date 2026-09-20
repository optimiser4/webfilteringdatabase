# webfilteringdatabase

A zero-dependency Node.js client for the [Web Filtering Database](https://www.webfilteringdatabase.com) API. One call classifies any domain or URL into the 59-category web filtering taxonomy that firewalls, DNS resolvers, secure web gateways and parental-control products enforce, and returns the IAB content categories, buyer personas and detected language for the same site in the same response. The database behind it holds 120 million+ categorized domains and is also available as a downloadable dataset for deployments that must answer every lookup locally.

The 59 categories are organized in eight groups: web-based risks, adult and sensitive content, productivity, business and finance, communication, lifestyle, infrastructure and general web. A domain can carry more than one category, so a policy can express "block Gambling and Adult, log Social Networking, allow everything else" without a second data source.

---

## Installation

```bash
npm install webfilteringdatabase
```

No runtime dependencies. Node.js 14 and newer are supported, and TypeScript definitions ship with the package.

## Quick start

```js
const WebFilteringClient = require('webfilteringdatabase');

const client = new WebFilteringClient('YOUR_API_KEY');

(async () => {
  const c = await client.classify('bbc.com');
  console.log(c.filteringCategories);        // [ 'Business', 'News/Media', 'Political' ]
  console.log(c.primaryFilteringCategory);   // 'Business'
  console.log(c.iabCategories);              // [ 'News' ]
  console.log(c.iabV2Categories);            // [ 'News and Politics' ]
  console.log(c.language);                   // 'en'
  console.log(c.remainingCredits);           // 1499998

  if (await client.isInCategory('example-casino.com', ['Gambling'])) {
    // block
  }
})();
```

The API key is issued in the account area after a plan is activated and is sent as the `api_key` form field on every request.

With ES modules or TypeScript:

```ts
import WebFilteringClient, { Classification } from 'webfilteringdatabase';

const client = new WebFilteringClient(process.env.WFD_API_KEY!);
const c: Classification = await client.classify('https://www.espn.com/nba/');
console.log(c.filtering);   // [ { category: 'Sports & Recreation', confidence: 1 } ]
```

## What a classification contains

| Field | Type | Meaning |
|---|---|---|
| `filtering` | `{category, confidence}[]` | web filtering categories from the 59-category taxonomy, highest confidence first |
| `iab` | `{category, confidence}[]` | IAB content taxonomy tier 1 categories |
| `iabV2` | `{category, confidence}[]` | the newer IAB content taxonomy, including tier 2 paths such as `News and Politics > National News` |
| `buyer_personas` | `string[]` | audience personas inferred for the site |
| `language` | string | primary language of the site, ISO code |
| `remaining_credits` | number | credits left on the plan after this call |
| `total_credits` | number | credits on the plan |
| `status` | number | 200 on success |

The raw API fields (`filtering_taxonomy`, `iab_taxonomy`, `iab_taxonomy_version2`) are kept on the object as the API returns them. The client parses their `"Category name: X"` and `"Confidence: 0.9"` pairs into the arrays above and adds the accessors `filteringCategories`, `primaryFilteringCategory`, `iabCategories`, `iabV2Categories`, `personas`, `remainingCredits` and `inCategory(names)`.

## Methods

| Method | Credits | Returns |
|---|---|---|
| `classify(domainOrUrl)` | 1 | `Classification` |
| `category(domainOrUrl)` | 1 | the best web filtering category as a string, or `null` |
| `isInCategory(domainOrUrl, names)` | 1 | `boolean`, true when any of the site's categories matches |
| `classifyMany(domains, {concurrency, pauseMs})` | 1 per unique domain | array in input order; a failed lookup is `{query, error, status}` instead of an exception |

All methods call `POST https://www.webfilteringdatabase.com/api/moderate.php` with the form fields `query`, `data_type=url` and `api_key`. A full URL is classified as that URL; a bare host is lower-cased and sent without `www.`.

## Errors

| Status | Error class | When |
|---|---|---|
| 401, 403 | `AuthenticationError` | no key, a misspelled key, or a plan that is not active |
| 429 | `RateLimitError` | too many requests for the plan |
| 500 | `ClassificationError` | the site could not be loaded or classified (the message names the cause) |
| other | `WebFilteringError` | network failure after two retries, or an unexpected response |

Every error carries `status` and the parsed response `body`. `classifyMany()` swallows classification errors per domain so one unreachable site does not stop a batch; authentication errors are still thrown, because retrying a bad key is pointless.

## The 59-category taxonomy

| Group | Examples |
|---|---|
| Web-based risks | Restricted / Suspicious, VPN / Proxy / Anonymizers, Remote Access Tools, URL Shorteners, Hate/Discrimination, Violence, Weapons, Illegal Drugs |
| Adult and sensitive | Adult, Lingerie/Swimsuits/Intimate Apparel, Gambling, Alcohol, Tobacco, Dating |
| Productivity and time | Social Networking, Gaming, Streaming Media, and other categories restricted during work or study hours |
| Business and finance | Business, Finance, Job Search and related commercial categories |
| Communication | Email, chat, forums and messaging platforms |
| Lifestyle | Sports & Recreation, Travel, Food, Health, Shopping |
| Infrastructure | Content delivery, hosting, software downloads and technical services |
| General web | News/Media, Political, Education, Reference and the remaining content categories |

The complete list with a definition for each category is on the [web filtering categories page](https://www.webfilteringdatabase.com/categories-web-filtering.php).

## Worked examples

### 1. Policy hook inside a DNS resolver

A filtering resolver decides per query name. The function below is the policy layer: it classifies the name on first sight, caches the answer for a day and returns `block`, `log` or `allow`. Plug it into whichever resolver framework you run; the resolver only needs to call `decide(name)` before answering.

```js
const WebFilteringClient = require('webfilteringdatabase');

const client = new WebFilteringClient(process.env.WFD_API_KEY);
const cache = new Map();                     // host -> {action, expires}
const DAY = 24 * 60 * 60 * 1000;

const BLOCK = ['Adult', 'Gambling', 'Illegal Drugs', 'Weapons', 'Violence', 'Hate/Discrimination',
               'Restricted / Suspicious', 'VPN / Proxy / Anonymizers'];
const LOG = ['Social Networking', 'Gaming', 'Streaming Media', 'Dating'];

async function decide(name) {
  const host = WebFilteringClient.normalizeQuery(name);
  const hit = cache.get(host);
  if (hit && hit.expires > Date.now()) return hit.action;

  let action = 'allow';
  try {
    const c = await client.classify(host);
    if (c.inCategory(BLOCK)) action = 'block';
    else if (c.inCategory(LOG)) action = 'log';
  } catch (err) {
    action = 'allow';                        // fail open, keep the network up
    console.error('classification failed for', host, err.message);
  }
  cache.set(host, { action, expires: Date.now() + DAY });
  return action;
}

module.exports = { decide };
```

Because a resolver sees the same few thousand hosts all day, the cache absorbs almost all traffic and the API is only called for names it has not seen.

### 2. Category check in a secure web gateway

A gateway plugin that receives the request URL, checks the category, and either passes the request through, injects a warning header or returns a block page. The example uses plain `http` so it drops into any proxy framework.

```js
const http = require('http');
const WebFilteringClient = require('webfilteringdatabase');

const client = new WebFilteringClient(process.env.WFD_API_KEY);
const BLOCKED = new Set(['Adult', 'Gambling', 'Restricted / Suspicious']);

http.createServer(async (req, res) => {
  const target = req.headers['x-target-url'];
  if (!target) { res.writeHead(400); return res.end('x-target-url header required'); }

  const c = await client.classify(target);
  const cats = c.filteringCategories;

  if (cats.some((x) => BLOCKED.has(x))) {
    res.writeHead(403, { 'Content-Type': 'text/html', 'X-Filter-Category': cats.join(';') });
    return res.end(`<h1>Blocked</h1><p>${c.query} is categorized as ${cats.join(', ')}.</p>`);
  }
  res.writeHead(200, { 'X-Filter-Category': cats.join(';'), 'X-Filter-Language': c.language || '' });
  res.end('allowed');
}).listen(8090);
```

### 3. Batch classification of a domain list to CSV

Compliance reviews often start from a list of the top few thousand destinations seen last month. `classifyMany()` runs four requests in parallel by default and returns rows in input order, so the output CSV lines up with the input file.

```js
const fs = require('fs');
const WebFilteringClient = require('webfilteringdatabase');

const client = new WebFilteringClient(process.env.WFD_API_KEY);

(async () => {
  const domains = fs.readFileSync('top-destinations.txt', 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  const rows = await client.classifyMany(domains, { concurrency: 4 });

  const csv = ['domain,filtering_categories,iab_category,language,error'];
  for (const r of rows) {
    if (r.error) { csv.push(`${r.query},,,,"${r.error}"`); continue; }
    csv.push([
      r.query,
      `"${r.filteringCategories.join('; ')}"`,
      `"${(r.iabCategories[0] || '')}"`,
      r.language || '',
      '',
    ].join(','));
  }
  fs.writeFileSync('top-destinations-categorized.csv', csv.join('\n'));
  console.log(`${rows.length} domains classified`);
})();
```

### 4. Nightly refresh of a local category table

For a local table, classify only the domains that are new since yesterday and merge the result into SQLite, Redis or a flat file. The pattern keeps credit use proportional to what changed.

```js
const fs = require('fs');
const client = new WebFilteringClient(process.env.WFD_API_KEY);

(async () => {
  const known = new Set(fs.readFileSync('categories.tsv', 'utf8').split('\n').map((l) => l.split('\t')[0]));
  const seen = fs.readFileSync('hosts-today.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const fresh = seen.filter((h) => !known.has(h));

  const rows = await client.classifyMany(fresh, { concurrency: 3, pauseMs: 100 });
  const lines = rows.filter((r) => !r.error).map((r) => `${r.query}\t${r.filteringCategories.join(';')}`);
  fs.appendFileSync('categories.tsv', '\n' + lines.join('\n'));
  console.log(`${fresh.length} new hosts, ${lines.length} classified`);
})();
```

## Why a filtering taxonomy rather than a content taxonomy

Content taxonomies describe what a page is about; a filtering taxonomy describes what a policy needs to do with it. "Gambling", "VPN / Proxy / Anonymizers" and "Remote Access Tools" are not topics an advertiser cares about, but they are exactly the categories a school, a hospital or a bank blocks by default. The Web Filtering Database returns both taxonomies in one response so that a gateway can enforce on the filtering category while a reporting dashboard groups traffic by IAB content category.

The obligations behind those policies are public. In the United States, schools and libraries that receive E-Rate discounts must operate a technology protection measure under the Children's Internet Protection Act; the [FCC's CIPA guide](https://www.fcc.gov/consumers/guides/childrens-internet-protection-act) sets out what has to be blocked, and the [American Library Association's CIPA page](https://www.ala.org/advocacy/advleg/federallegislation/cipa) covers implementation in libraries. Enterprises reach the same controls through the [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework), whose Protect function includes restricting access to known-bad and policy-violating destinations. Because most filters act at the DNS layer, the mechanics follow [RFC 1035](https://www.rfc-editor.org/rfc/rfc1035): the resolver sees the query name before any connection is made, which is why the resolver hook above is the most efficient place to enforce. The general history and design space of these products is summarized in the [Wikipedia article on content-control software](https://en.wikipedia.org/wiki/Content-control_software).

## Adjacent policy data from the same team

Web filtering categories cover the whole web at domain level. Three newer questions sit next to them in the same policy engine.

Which of those domains are AI tools, and of what kind, is answered by the [AI domain blocklist](https://www.aitoolsblocklist.com): 20,000+ AI-tool domains in 18 functional categories, refreshed daily, delivered in the same EDL, PAC, hosts and DNS formats as a filtering feed, so a resolver can block deepfake generators while allowing an approved coding assistant. Which AI tools are already in use on a network, before any rule is written, is what a [shadow AI discovery tool](https://www.shadowaitools.com) answers from a DNS, proxy or firewall export, with a per-user breakdown and a dated verdict on whether each vendor trains on submitted data.

And which pages an organization's own browsing agents may open is the job of the [AI agent allow list](https://www.aiagentallowlist.com): verified page-type URLs for 40 million+ domains, up to 28 types each, so agent gateways can allow documentation and pricing pages while denying login, checkout and upload surfaces per URL and per HTTP method. Category data plus [per-URL policy for browsing agents](https://www.aiagentallowlist.com) is what an agent-aware gateway enforces.

## Related packages

- [`aiblocklist`](https://www.npmjs.com/package/aiblocklist) (npm), [`aiblocklist`](https://pypi.org/project/aiblocklist/) (PyPI): AI tool domain lookups with data-use verdicts
- [`aitoolsblocklist`](https://www.npmjs.com/package/aitoolsblocklist) (npm), [`aitoolsblocklist`](https://pypi.org/project/aitoolsblocklist/) (PyPI): the original AI tools blocklist client
- [`aiagentallowlist`](https://www.npmjs.com/package/aiagentallowlist) (npm), [`aiagentallowlist`](https://pypi.org/project/aiagentallowlist/) (PyPI): per-URL verdicts for browsing agents
- [`shadowaitools`](https://www.npmjs.com/package/shadowaitools) (npm), [`shadowaitools`](https://pypi.org/project/shadowaitools/) (PyPI): local shadow AI inventory from log exports
- [`phishingdetectionapi`](https://www.npmjs.com/package/phishingdetectionapi) (npm), [`phishingdetectionapi`](https://pypi.org/project/phishingdetectionapi/) (PyPI): active phishing domain verdicts
- [`websitecategorization`](https://www.npmjs.com/package/websitecategorization) (npm), [`websiteclassificationapi`](https://pypi.org/project/websiteclassificationapi/) (PyPI): IAB content categories for any URL
- [`cipawebfiltering`](https://www.npmjs.com/package/cipawebfiltering) (npm), [`cipawebfiltering`](https://pypi.org/project/cipawebfiltering/) (PyPI): school and library filtering
- [`webfiltering`](https://rubygems.org/gems/webfiltering) (RubyGems): the Ruby client for this database

Products: [website categorization API](https://www.websitecategorizationapi.com), [phishing detection API](https://www.phishingdetectionapi.com), [CIPA web filtering](https://www.cipawebfiltering.com), [PII detection API](https://www.piidetectionapi.com).

Source: [github.com/explainableaixai/webfilteringdatabase](https://github.com/explainableaixai/webfilteringdatabase) and [gitlab.com/url-classifications/webfilteringdatabase](https://gitlab.com/url-classifications/webfilteringdatabase).

## Frequently asked questions

**What is the Web Filtering Database?**
The Web Filtering Database at [webfilteringdatabase.com](https://www.webfilteringdatabase.com) is a database of 120 million+ domains classified into 59 web filtering categories, available as a REST API and as a downloadable dataset. It is built for firewalls, DNS resolvers, secure web gateways, proxies and parental-control products that need a category for every destination on the network.

**How do I get the web filtering category of a domain in Node.js?**
Install with `npm install webfilteringdatabase`, create a client with your API key and call `classify(domain)`. The result's `filteringCategories` array holds the 59-taxonomy categories, `iabCategories` holds the IAB content categories, and `inCategory(['Gambling', 'Adult'])` gives a boolean for policy gates.

**Can a domain have more than one category?**
Yes. A news site can be `Business`, `News/Media` and `Political` at once. The `filtering` array lists every category with its confidence, highest first, and `primaryFilteringCategory` returns the top one.

**Does the API classify full URLs or only domains?**
Both. Send a full URL to classify that page; send a bare domain to classify the site. The example above classifies `https://www.espn.com/nba/` as `Sports & Recreation`.

**How do I classify thousands of domains?**
Use `classifyMany(domains, {concurrency: 4})`. It deduplicates the input, runs a few requests in parallel, returns results in input order and reports a failed lookup as a row with an `error` field instead of stopping the batch.

**Is the whole database available offline?**
Yes. The database is licensed as a downloadable dataset for on-premises resolvers and appliances that cannot make an outbound call per query. The API and the dataset use the same 59-category taxonomy. Details are on [webfilteringdatabase.com](https://www.webfilteringdatabase.com).

**Which categories do schools block for CIPA?**
Typically the adult and sensitive group (Adult, Gambling, Dating, Alcohol, Tobacco), the web-based risks group (Restricted / Suspicious, Hate/Discrimination, Violence, Weapons, Illegal Drugs, VPN / Proxy / Anonymizers) and, during school hours, Social Networking, Gaming and Streaming Media. The [CIPA web filtering](https://www.cipawebfiltering.com) site covers school deployments in detail.

**Who builds the Web Filtering Database?**
Alpha Quantum, the company behind the [website categorization API](https://www.websitecategorizationapi.com), the [phishing detection API](https://www.phishingdetectionapi.com), the [AI tools blocklist](https://www.aitoolsblocklist.com) and the [AI agent allow list](https://www.aiagentallowlist.com). All share the same 120-million-domain intelligence corpus.

## Links

- Product and API documentation: [https://www.webfilteringdatabase.com/api-docs.php](https://www.webfilteringdatabase.com/api-docs.php)
- The 59 web filtering categories: [https://www.webfilteringdatabase.com/categories-web-filtering.php](https://www.webfilteringdatabase.com/categories-web-filtering.php)
- FCC, Children's Internet Protection Act: [https://www.fcc.gov/consumers/guides/childrens-internet-protection-act](https://www.fcc.gov/consumers/guides/childrens-internet-protection-act)
- ALA, CIPA: [https://www.ala.org/advocacy/advleg/federallegislation/cipa](https://www.ala.org/advocacy/advleg/federallegislation/cipa)
- NIST Cybersecurity Framework: [https://www.nist.gov/cyberframework](https://www.nist.gov/cyberframework)
- RFC 1035: [https://www.rfc-editor.org/rfc/rfc1035](https://www.rfc-editor.org/rfc/rfc1035)
- Wikipedia, Content-control software: [https://en.wikipedia.org/wiki/Content-control_software](https://en.wikipedia.org/wiki/Content-control_software)

## License

MIT
