// functions/api/debug-env.js
//
// TEMPORARY debug endpoint — checks env var lengths and whether they have
// leading/trailing whitespace, WITHOUT exposing the actual secret values.
// Delete this file once the SPOTIFY_REFRESH_TOKEN issue is resolved.

export async function onRequestGet(context) {
  const { env } = context;

  function inspect(name, value) {
    if (value === undefined || value === null) {
      return { name, present: false };
    }
    return {
      name,
      present: true,
      length: value.length,
      hasLeadingWhitespace: /^\s/.test(value),
      hasTrailingWhitespace: /\s$/.test(value),
      hasNewline: /[\r\n]/.test(value),
      first4: value.slice(0, 4),
      last4: value.slice(-4),
    };
  }

  return new Response(
    JSON.stringify(
      {
        clientId: inspect('SPOTIFY_CLIENT_ID', env.SPOTIFY_CLIENT_ID),
        clientSecret: inspect('SPOTIFY_CLIENT_SECRET', env.SPOTIFY_CLIENT_SECRET),
        refreshToken: inspect('SPOTIFY_REFRESH_TOKEN', env.SPOTIFY_REFRESH_TOKEN),
      },
      null,
      2
    ),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
