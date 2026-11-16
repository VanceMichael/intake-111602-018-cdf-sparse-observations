export function dispatch({ url, phase }) {
  if (url.pathname === '/releases') return { json: { release: `space-${phase + 1}`, file: '/files/space.cdf', requestedRange: [1, 3], variables: ['Flux', 'Quality'] } };
  return null;
}
