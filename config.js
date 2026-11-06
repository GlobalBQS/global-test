// GlobalBQS test environment – all pages here talk to the DEMO project only.
// The publishable key is public by design (same as in any web page); no secrets in this repo.
window.GBQS_TEST = {
  env: 'demo',
  supabaseUrl: 'https://sihgseutmekszhcwbgzw.supabase.co',
  publishableKey: 'sb_publishable_i357EVMHxS3Ps_Rt6b8kgQ_6m-XL49U',
  version: '1.0.0'
};

// Read #access_token=…&type=… or ?error=… from the URL (Supabase auth redirect)
window.gbqsAuthParams = function () {
  const out = {};
  const add = (s) => new URLSearchParams(s).forEach((v, k) => { out[k] = v; });
  if (location.search) add(location.search.slice(1));
  if (location.hash) add(location.hash.slice(1));
  return out;
};

window.gbqsFn = async function (name, body) {
  const c = window.GBQS_TEST;
  let r;
  try {
    r = await fetch(`${c.supabaseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: c.publishableKey },
      body: JSON.stringify(body)
    });
  } catch {
    return { status: 0, data: { ok: false, message: 'Could not reach the demo. Check your connection and try again.' } };
  }
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
};
