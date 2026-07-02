import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// Gmail via IMAP app-passwords. Multi-account: GMAIL_USER_1/GMAIL_APP_PASSWORD_1/GMAIL_LABEL_1, _2, ...
// Read-only by design; drafting/sending stays with Kirby (vision doc: sending always requires approval).

export type MailAccount = { label: string; user: string; pass: string };

export function mailAccounts(): MailAccount[] {
  const out: MailAccount[] = [];
  for (let i = 1; i <= 4; i++) {
    const user = process.env[`GMAIL_USER_${i}`];
    const pass = process.env[`GMAIL_APP_PASSWORD_${i}`];
    if (user && pass) out.push({ label: process.env[`GMAIL_LABEL_${i}`] ?? user.split("@")[0], user, pass: pass.replace(/\s+/g, "") });
  }
  return out;
}

async function withImap<T>(acc: MailAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: acc.user, pass: acc.pass },
    logger: false, socketTimeout: 20000,
  });
  await client.connect();
  try { return await fn(client); }
  finally { await client.logout().catch(() => {}); }
}

export type MailHead = { account: string; uid: number; from: string; subject: string; date: string; snippet: string; unread: boolean };

export async function searchMail(query: string, days = 30, limit = 8): Promise<MailHead[]> {
  const accounts = mailAccounts();
  const since = new Date(Date.now() - days * 86400_000);
  const all: MailHead[] = [];
  for (const acc of accounts) {
    try {
      await withImap(acc, async (c) => {
        await c.mailboxOpen("INBOX", { readOnly: true });
        const crit: Record<string, unknown> = { since };
        if (query.trim()) crit.or = [{ subject: query }, { from: query }, { body: query }];
        const uids = (await c.search(crit as never, { uid: true })) || [];
        const recent = uids.slice(-limit);
        for await (const msg of c.fetch(recent, { uid: true, envelope: true, flags: true, bodyStructure: true, source: false }, { uid: true })) {
          all.push({
            account: acc.label, uid: msg.uid,
            from: msg.envelope?.from?.map((f) => `${f.name ?? ""} <${f.address}>`).join(", ") ?? "",
            subject: msg.envelope?.subject ?? "(no subject)",
            date: msg.envelope?.date?.toISOString?.() ?? "",
            snippet: "", unread: !(msg.flags?.has("\\Seen")),
          });
        }
      });
    } catch (e) { all.push({ account: acc.label, uid: -1, from: "", subject: `⚠ ${acc.label} unreachable: ${String(e).slice(0, 80)}`, date: "", snippet: "", unread: false }); }
  }
  return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit * 2);
}

export async function readMail(accountLabel: string, uid: number): Promise<string> {
  const acc = mailAccounts().find((a) => a.label === accountLabel || a.user === accountLabel);
  if (!acc) return "unknown account";
  try {
    return await withImap(acc, async (c) => {
      await c.mailboxOpen("INBOX", { readOnly: true });
      const { content } = await c.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const ch of content) chunks.push(ch as Buffer);
      const parsed = await simpleParser(Buffer.concat(chunks));
      const body = (parsed.text ?? parsed.html ?? "").toString();
      const addr = (a: unknown) => Array.isArray(a) ? a.map((x) => (x as { text?: string }).text ?? "").join(", ") : ((a as { text?: string })?.text ?? "");
      return `From: ${addr(parsed.from)}\nTo: ${addr(parsed.to)}\nDate: ${parsed.date?.toISOString?.() ?? ""}\nSubject: ${parsed.subject}\n\n${body}`.slice(0, 14000);
    });
  } catch (e) { return `read failed: ${String(e).slice(0, 150)}`; }
}
