/**
 * Device identity and local preferences.
 *
 * The device id is generated once per browser and kept in localStorage. It is
 * what lets the server give you your seat back after a reload or a dropped
 * connection — it is an identifier, not a credential, and it is the only thing
 * standing in for an account.
 */

const DEVICE_KEY = 'ludo.deviceId';
const PROFILE_KEY = 'ludo.profile';

/** URL-safe, 24 chars — matches the server's `[A-Za-z0-9_-]{16,64}` rule. */
function generateDeviceId() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function getDeviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    // Private mode with storage disabled: fall through to a session-only id.
  }
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = generateDeviceId();
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* the id still works for this page's lifetime */
    }
  }
  return id;
}

export function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}');
    return { name: raw.name ?? '', avatar: Number(raw.avatar) || 0 };
  } catch {
    return { name: '', avatar: 0 };
  }
}

export function saveProfile({ name, avatar }) {
  const profile = { name: String(name ?? '').slice(0, 14), avatar: Number(avatar) || 0 };
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* preferences simply do not persist */
  }
  return profile;
}

export const hasProfile = () => loadProfile().name.trim().length >= 2;
