// Tells the person when a Claude or Codex chat starts waiting on them.
// Off unless switched on in Settings; checks every 20 seconds and only reads
// what changed since the last check.
import fs from 'node:fs';
import path from 'node:path';
import { Notification, shell } from 'electron';
import { NeedsWatcher } from '../lib/needs.mjs';
import { CACHE } from '../lib/paths.mjs';

const POLL_MS = 20_000;
const SEEN_FILE = path.join(CACHE, 'notified.json');
const KEEP_MS = 14 * 86_400_000;
const FRESH_MS = 6 * 3_600_000; // older asks are not news
const MAX_PER_CHECK = 3;
const SUBTITLE = { claude: 'Claude is waiting on you', codex: 'Codex is waiting on you' };

export class Notifier {
  constructor() {
    this.watcher = new NeedsWatcher();
    this.timer = null;
    this.seen = null;
    this.busy = false;
    this.live = new Set(); // a notification that is garbage collected loses its click handler
  }

  get running() {
    return Boolean(this.timer);
  }

  // quiet: what is already waiting when notifications are switched on is not news.
  start({ quiet = false } = {}) {
    if (this.timer) return;
    this.seen = this.load();
    const firstEver = this.seen === null;
    this.seen ||= new Map();
    this.check(quiet || firstEver);
    this.timer = setInterval(() => this.check(false), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  load() {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))));
    } catch {
      return null;
    }
  }

  save() {
    const now = Date.now();
    const keep = {};
    for (const [key, t] of this.seen) if (now - t < KEEP_MS) keep[key] = t;
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(keep));
  }

  async check(quiet) {
    if (this.busy) return;
    this.busy = true;
    try {
      const fresh = (await this.watcher.scan()).filter((n) => !this.seen.has(n.key));
      if (!fresh.length) return;
      for (const n of fresh) this.seen.set(n.key, Date.now());
      this.save();
      if (quiet) return;
      for (const n of fresh.filter((n) => Date.now() - n.at < FRESH_MS).slice(0, MAX_PER_CHECK)) this.show(n);
    } catch {
      /* a file was mid-write; the next check picks it up */
    } finally {
      this.busy = false;
    }
  }

  show({ title, app, text, link }, subtitle = SUBTITLE[app]) {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title, subtitle, body: text });
    this.live.add(note);
    const done = () => this.live.delete(note);
    note.on('click', () => {
      done();
      if (link) shell.openExternal(link);
    });
    note.on('close', done);
    note.show();
  }

  test() {
    this.show({ title: 'Recap', text: "You'll get a note like this when a Claude or Codex chat needs you.", link: null }, 'Notifications are on');
  }
}
