// Public share links load only the read-only viewer, so private credential code never runs on them.
const root = document.getElementById('root');
const share = /^\/s\/([^/]+)\/?$/.exec(location.pathname);

if (share) {
  const { mountPublic } = await import('/public.js');
  mountPublic(root, share[1]);
} else {
  const { mountApp } = await import('/app.js');
  mountApp(root);
}
