// functions/api/debug-kv.js
//
// TEMPORARY diagnostic endpoint — checks whether the APPLE_MUSIC_LINKS KV
// binding exists and can read a known key. Delete once the Apple Music
// button issue is resolved.

export async function onRequestGet(context) {
  const { env } = context;

  const bindingPresent = !!env.APPLE_MUSIC_LINKS;
  let testLookup = null;
  let testLookupError = null;

  if (bindingPresent) {
    try {
      testLookup = await env.APPLE_MUSIC_LINKS.get('exit');
    } catch (err) {
      testLookupError = String(err && err.message || err);
    }
  }

  return new Response(
    JSON.stringify(
      {
        bindingPresent,
        testLookupKey: 'exit',
        testLookupResult: testLookup,
        testLookupError,
      },
      null,
      2
    ),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
