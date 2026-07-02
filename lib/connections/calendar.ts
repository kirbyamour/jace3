import ical from "node-ical";

// Google Calendar via secret iCal addresses. Multi-calendar: GCAL_ICS_URL_1/GCAL_LABEL_1, _2, ...
export type CalAccount = { label: string; url: string };

export function calendars(): CalAccount[] {
  const out: CalAccount[] = [];
  for (let i = 1; i <= 6; i++) {
    const url = process.env[`GCAL_ICS_URL_${i}`];
    if (url) out.push({ label: process.env[`GCAL_LABEL_${i}`] ?? `calendar ${i}`, url });
  }
  return out;
}

export type CalEvent = { calendar: string; title: string; start: string; end: string; location?: string; allDay: boolean };

export async function upcomingEvents(daysAhead = 7): Promise<CalEvent[]> {
  const now = new Date();
  const until = new Date(now.getTime() + daysAhead * 86400_000);
  const out: CalEvent[] = [];
  for (const cal of calendars()) {
    try {
      const data = await ical.async.fromURL(cal.url);
      for (const k of Object.keys(data)) {
        const ev = data[k] as ical.VEvent & { rrule?: { between: (a: Date, b: Date) => Date[] } };
        if (ev.type !== "VEVENT") continue;
        const pushEv = (start: Date) => {
          const durMs = (ev.end?.getTime?.() ?? start.getTime()) - (ev.start?.getTime?.() ?? start.getTime());
          out.push({
            calendar: cal.label, title: String((ev.summary as unknown as { val?: string })?.val ?? ev.summary ?? "(untitled)"),
            start: start.toISOString(), end: new Date(start.getTime() + Math.max(durMs, 0)).toISOString(),
            location: String((ev.location as unknown as { val?: string })?.val ?? ev.location ?? "") || undefined,
            allDay: Boolean((ev as { datetype?: string }).datetype === "date"),
          });
        };
        if (ev.rrule) {
          for (const d of ev.rrule.between(now, until)) pushEv(d);
        } else if (ev.start && ev.start >= now && ev.start <= until) {
          pushEv(ev.start);
        }
      }
    } catch (e) {
      out.push({ calendar: cal.label, title: `⚠ calendar unreachable: ${String(e).slice(0, 80)}`, start: now.toISOString(), end: now.toISOString(), allDay: false });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 40);
}
