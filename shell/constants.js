// Shared shell constants. Kept in one place so the HTTP port and the derived
// Spotify OAuth redirect URI can't drift apart (Spotify's registered redirect
// must match exactly).
const PORT = 8097;
module.exports = { PORT };
