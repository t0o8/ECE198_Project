/* Where the dashboard keeps its data. Loaded before every other script.

   apiBase: ''            keep everything in this browser (localStorage). No server needed.
   apiBase: '/api'        use a backend on the same site (for example server/server.py).
   apiBase: 'https://example.org/api'   use a backend somewhere else (it must allow CORS).

   The API the backend has to provide is described in API.md.

   For a quick test without editing this file, add ?api=<address> to any page's address,
   for example index.html?api=http://localhost:8000/api. The choice is remembered in this
   browser; ?api=off goes back to browser storage.

   When server/server.py serves the site, it sends its own copy of this file with
   apiBase set to '/api', so nothing needs changing here. */
window.CC = window.CC || {};
window.CC.CONFIG = {
  apiBase: '',
};
