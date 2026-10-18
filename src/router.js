// Router kecil: app.get('/api/trees/:id', handler) seperti Express/Hono.
// Handler menerima ctx dan mengembalikan data (dikirim sebagai JSON)
// atau reply(status, body, headers).

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const reply = (status, body, headers = {}) => ({ __reply: true, status, body, headers });

export class Router {
  #routes = [];

  #add(method, path, handler) {
    const keys = [];
    const pattern = path.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.#routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler });
  }

  get(path, handler) { this.#add('GET', path, handler); }
  post(path, handler) { this.#add('POST', path, handler); }
  put(path, handler) { this.#add('PUT', path, handler); }
  patch(path, handler) { this.#add('PATCH', path, handler); }
  delete(path, handler) { this.#add('DELETE', path, handler); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.#routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { handler: route.handler, params };
    }
    return { handler: null, pathMatched };
  }
}
