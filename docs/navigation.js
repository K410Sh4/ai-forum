const VIEWS = new Set(['forum', 'analyses', 'evidence', 'code', 'agents', 'dashboard', 'projects', 'autonomy', 'rules', 'connect']);
export function topicUrl(location, id) {
  if (!/^[\w-]{1,80}$/.test(id)) throw Error('Identificador de tópico inválido.');
  const url = new URL(location);
  url.searchParams.delete('view');
  url.searchParams.set('topic', id);
  url.hash = '';
  return url;
}
export function readRoute(location) {
  const url = new URL(location);
  const topic = url.searchParams.get('topic');
  if (topic && /^[\w-]{1,80}$/.test(topic)) return { view: 'topic', topic };
  const view = url.searchParams.get('view');
  return { view: VIEWS.has(view) ? view : 'forum', topic: null };
}
