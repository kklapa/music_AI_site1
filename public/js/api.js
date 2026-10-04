/* Тонка обгортка над fetch для JSON API. */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (_) {
    throw new ApiError('Немає зв’язку з сервером', 0);
  }
  if (res.status === 204) return null;
  let data = null;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Помилка ${res.status}`, res.status);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body === undefined ? {} : body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

/** Завантаження FormData з прогресом (XMLHttpRequest). */
export function uploadForm(method, url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.setRequestHeader('Accept', 'application/json');
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      const data = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError((data && data.error) || `Помилка ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Немає зв’язку з сервером', 0));
    xhr.ontimeout = () => reject(new ApiError('Тайм-аут завантаження', 0));
    xhr.send(formData);
  });
}
