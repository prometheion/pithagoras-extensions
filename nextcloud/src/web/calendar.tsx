import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";
import { SubTabs } from "./widgets";

/** The Calendar tab: a day agenda over the days -- what is on the chosen day of which calendar, and where the next
 * seven reach past it; and one event open to its detail, read or changed (title, times, text, place) and taken away.
 * A recurring event is only listed with a note that changing it stays in Nextcloud itself. And beside the events:
 * a todo sub-view over what is still open, to be ticked off. All of it as a tool call on the server. */

type Rec = Record<string, unknown>;

const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

interface CalendarRow {
  name: string; // the calendar's id in its own words
  displayName: string;
  readOnly: boolean;
}
interface EventSummary {
  uid: string;
  summary: string;
  start?: string;
  end?: string;
  allDay: boolean;
  location?: string;
  description?: string;
  calendarName?: string;
}

/** An event read in full: what its list row knows, plus what only the detail answer carries. */
interface EventFull extends EventSummary {
  recurring: boolean;
}
interface TodoRow {
  uid: string;
  summary: string;
  due?: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** A day in the tool's words from a Date. */
const dayWord = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** An ISO word back to what a datetime-local input speaks -- or its date half alone for an all-day field. */
const localInput = (iso: string | undefined, dateOnly = false): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function Calendar() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the calendar calls go
  const [view, setView] = useState<"events" | "todos">("events");

  // the calendars and which is open (the first one the server says is writable)
  const [calendars, setCalendars] = useState<CalendarRow[] | null>(null);
  const [calendarProblem, setCalendarProblem] = useState<string | null>(null);
  const [calendarName, setCalendarName] = useState<string | null>(null);

  // the agenda: the day it shows and the events it read for it
  const [day, setDay] = useState<string>(() => dayWord(new Date()));
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventProblem, setEventProblem] = useState<string | null>(null);

  // the one event open and its edit words as they stand (wall-clock words, what the input speaks)
  const [event, setEvent] = useState<EventFull | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editAllDay, setEditAllDay] = useState(false);
  const [editStartLocal, setEditStartLocal] = useState("");
  const [editEndLocal, setEditEndLocal] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [eventProblem2, setEventProblem2] = useState<string | null>(null);

  // the todo sub-view: which calendar's todos are shown and what is open in it
  const [todoCal, setTodoCal] = useState<string | null>(null);
  const [todos, setTodos] = useState<TodoRow[] | null>(null);
  const [todoProblem, setTodoProblem] = useState<string | null>(null);

  // the new-event form: its words as they stand
  const [newTitle, setNewTitle] = useState("");
  const [newAllDay, setNewAllDay] = useState(false);
  const [newStartAt, setNewStartAt] = useState("09:00");
  const [newEndAt, setNewEndAt] = useState("10:00");

  const [busy, setBusy] = useState(false);

  const loadCalendars = () => {
    setCalendars(null);
    setCalendarProblem(null);
    void api
      .tool("nc_calendar_list_calendars", {}, instance)
      .then((result) => {
        const rows = (arrayOf(partText(result).data, "calendars") ?? []).map((c) => ({ name: String(c.name), displayName: String(c.display_name ?? c.name), readOnly: Boolean(c.read_only) }));
        setCalendars(rows);
        if (rows.length > 0 && calendarName === null) {
          const first = rows.find((r) => !r.readOnly) ?? rows[0];
          setCalendarName(first.name);
          setTodoCal(first.name);
        }
      })
      .catch((error) => setCalendarProblem(sayError(error)));
  };

  useEffect(() => {
    loadCalendars();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadEvents = (dayKey: string, name: string | null) => {
    if (name === null) return;
    setEvents(null);
    setEventProblem(null);
    void api
      .tool("nc_calendar_list_events", { calendar_name: name, start_date: dayKey, end_date: dayKey, limit: 50 }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? (data as Rec).events : undefined;
        setEvents(
          Array.isArray(list)
            ? list.map((e) => {
                const r = e as Rec;
                return {
                  uid: String(r.uid ?? ""),
                  summary: String(r.summary ?? ""),
                  start: strOf(r.start),
                  end: strOf(r.end),
                  allDay: Boolean(r.all_day),
                  location: strOf(r.location),
                  description: strOf(r.description),
                  calendarName: strOf(r.calendar_name),
                };
              })
            : []
        );
      })
      .catch((error) => setEventProblem(sayError(error)));
  };

  useEffect(() => {
    loadEvents(day, calendarName);
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEvent = (summary: EventSummary) => {
    if (calendarName === null || busy) return;
    setEvent(null);
    setEventProblem2(null);
    void api
      .tool("nc_calendar_get_event", { calendar_name: calendarName, event_uid: summary.uid }, instance)
      .then((result) => {
        const data = partText(result).data;
        if (typeof data !== "object" || data === null) throw new Error(t("The event did not answer in a way this panel reads."));
        const r = data as Rec;
        setEvent({
          uid: summary.uid,
          summary: String(r.summary ?? summary.summary),
          start: strOf(r.start),
          end: strOf(r.end),
          allDay: Boolean(r.all_day),
          location: strOf(r.location),
          description: strOf(r.description),
          calendarName: strOf(r.calendar_name) ?? summary.calendarName,
          recurring: Boolean(r.recurring),
        });
        setEditTitle(String(r.summary ?? summary.summary));
        const allDay = Boolean(r.all_day);
        setEditAllDay(allDay);
        setEditStartLocal(localInput(strOf(r.start), allDay));
        setEditEndLocal(localInput(strOf(r.end), false));
        setEditDescription(strOf(r.description) ?? "");
        setEditLocation(strOf(r.location) ?? "");
      })
      .catch((error) => setEventProblem2(sayError(error)));
  };

  const saveEvent = () => {
    if (event === null || calendarName === null) return;
    const args: Rec = { calendar_name: calendarName, event_uid: event.uid };
    let changed = false;
    if (editTitle.trim() !== "" && editTitle !== event.summary) {
      args.title = editTitle.trim();
      changed = true;
    }
    if (editAllDay !== event.allDay) {
      args.all_day = editAllDay;
      changed = true;
    }
    const originalStart = localInput(event.start, event.allDay);
    const originalEnd = localInput(event.end, false);
    const timesChanged = editAllDay !== event.allDay || editStartLocal !== originalStart || editEndLocal !== originalEnd;
    if (timesChanged) {
      // the wall-clock words back to what the tools take: a day-only word is an all-day word with midnight on
      // the tools take an all-day event's word as a day alone ("2025-01-15"), a timed one with its clock on
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(editStartLocal);
      const startIso = editStartLocal === "" ? undefined : dateOnly ? (editAllDay ? editStartLocal : `${editStartLocal}T00:00`) : `${editStartLocal}:00`;
      if (startIso !== undefined) args.start_datetime = startIso;
      if (!editAllDay && editEndLocal !== "" && !/\d{4}-\d{2}-\d{2}$/.test(editEndLocal)) {
        const endD = new Date(`${editEndLocal}:00`);
        const startD = new Date(startIso ?? "");
        if (!Number.isNaN(endD.getTime()) && !Number.isNaN(startD.getTime()) && endD > startD) args.end_datetime = `${editEndLocal}:00`;
      }
      changed = true;
    }
    if (editDescription !== (event.description ?? "")) {
      args.description = editDescription;
      changed = true;
    }
    if (editLocation !== (event.location ?? "")) {
      args.location = editLocation;
      changed = true;
    }
    if (!changed) return;
    void (async () => {
      setBusy(true);
      try {
        await api.tool("nc_calendar_update_event", args, instance);
        setEvent(null);
        loadEvents(day, calendarName);
      } catch (error) {
        setEventProblem2(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const deleteEvent = () => {
    if (event === null || calendarName === null) return;
    if (!window.confirm(t("Take this event away for good?"))) return;
    void (async () => {
      setBusy(true);
      try {
        await api.tool("nc_calendar_delete_event", { calendar_name: calendarName, event_uid: event.uid }, instance);
        setEvent(null);
        loadEvents(day, calendarName);
      } catch (error) {
        setEventProblem2(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const createEvent = () => {
    if (calendarName === null || newTitle.trim() === "") return;
    const start = new Date(`${day}T${newAllDay ? "00:00" : newStartAt}`);
    if (Number.isNaN(start.getTime())) return;
    void (async () => {
      setBusy(true);
      try {
        const args: Rec = {
          calendar_name: calendarName,
          title: newTitle.trim(),
          start_datetime: newAllDay ? day : `${day}T${newStartAt}:00`, // a day alone is the tool's all-day word
          all_day: newAllDay,
        };
        if (!newAllDay) {
          const end = new Date(`${day}T${newEndAt}:00`);
          args.end_datetime = !Number.isNaN(end.getTime()) && end > start ? `${day}T${newEndAt}:00` : undefined;
        }
        await api.tool("nc_calendar_create_event", args, instance);
        setNewTitle("");
        loadEvents(day, calendarName);
      } catch (error) {
        setEventProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const loadTodos = (name: string | null) => {
    if (name === null) return;
    setTodos(null);
    setTodoProblem(null);
    void api
      .tool("nc_calendar_list_todos", { calendar_name: name }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? (data as Rec).todos : undefined;
        setTodos(
          Array.isArray(list)
            ? list
                // only what is still open: the closed words are filtered out here, the tool's own statuses apart
                .filter((td) => { const s = String((td as Rec).status ?? "NEEDS-ACTION").toUpperCase(); return s !== "COMPLETED" && s !== "CANCELLED"; })
                .map((td) => {
                  const r = td as Rec;
                  return { uid: String(r.uid ?? ""), summary: String(r.summary ?? ""), due: strOf(r.due) };
                })
            : []
        );
      })
      .catch((error) => setTodoProblem(sayError(error)));
  };

  useEffect(() => {
    if (view === "todos" && todos === null) loadTodos(todoCal);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const completeTodo = (todo: TodoRow) => {
    if (todoCal === null || busy) return;
    void (async () => {
      setBusy(true);
      try {
        await api.tool("nc_calendar_complete_todo", { calendar_name: todoCal, todo_uid: todo.uid }, instance); // its own now is the timestamp
        loadTodos(todoCal);
      } catch (error) {
        setTodoProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  // ---- what is drawn -------------------------------------------------------

  if (event !== null) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setEvent(null)}>
            ← {t("Back to the agenda")}
          </button>
          <span className="flex-1" />
          {!event.recurring && (
            <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void deleteEvent()}>
              {t("Delete this event")}
            </button>
          )}
        </div>
        {event.recurring && (
          <p className="rounded-md border px-2 py-1 text-xs text-fg-muted" style={{ borderColor: "var(--line)", background: "var(--raised)" }}>
            {t("This is a recurring event. Changing it stays in Nextcloud itself.")}
          </p>
        )}
        <input className={portal.ui.classes.input} value={editTitle} aria-label={t("Event title")} disabled={event.recurring} onChange={(e) => setEditTitle(e.target.value)} />
        <div className="flex flex-wrap items-center gap-1">
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={editAllDay}
              disabled={event.recurring}
              onChange={(e) => {
                const nowAll = e.target.checked;
                setEditAllDay(nowAll);
                // the start field keeps one consistent word: a day alone all-day, or a wall clock from nine when it turns timed
                if (nowAll) setEditStartLocal(editStartLocal.slice(0, 10));
                else if (/^\d{4}-\d{2}-\d{2}$/.test(editStartLocal)) setEditStartLocal(`${editStartLocal}T09:00`);
              }}
            />
            {t("All day")}
          </label>
          {editAllDay ? (
            <input type="date" className={portal.ui.classes.inputSmall} value={editStartLocal} aria-label={t("On which day")} disabled={event.recurring} onChange={(e) => setEditStartLocal(e.target.value)} />
          ) : (
            <>
              <span className="text-xs text-fg-subtle">{t("From")}</span>
              <input type="datetime-local" className={portal.ui.classes.inputSmall} value={editStartLocal} aria-label={t("From")} disabled={event.recurring} onChange={(e) => setEditStartLocal(e.target.value)} />
              <span className="text-xs text-fg-subtle">{t("to")}</span>
              <input type="datetime-local" className={portal.ui.classes.inputSmall} value={editEndLocal} aria-label={t("To")} disabled={event.recurring} onChange={(e) => setEditEndLocal(e.target.value)} />
            </>
          )}
        </div>
        <textarea className="nc-note-text" rows={3} value={editDescription} placeholder={t("Description")} aria-label={t("Description")} disabled={event.recurring} onChange={(e) => setEditDescription(e.target.value)} />
        <input className={portal.ui.classes.input} value={editLocation} placeholder={t("Place")} aria-label={t("Place")} disabled={event.recurring} onChange={(e) => setEditLocation(e.target.value)} />
        {!event.recurring && (
          <button type="button" className={portal.ui.classes.primarySmall} disabled={busy} onClick={() => void saveEvent()}>
            {t("Save")}
          </button>
        )}
        {eventProblem2 !== null && <portal.ui.ErrorBanner onClose={() => setEventProblem2(null)}>{eventProblem2}</portal.ui.ErrorBanner>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SubTabs
        tabs={[
          { id: "events", label: t("Events") },
          { id: "todos", label: t("Todos") },
        ]}
        active={view}
        onChange={(id) => setView(id as "events" | "todos")}
      />

      {calendars !== null && calendars.length > 0 && (
        <select
          className={portal.ui.classes.inputSmall}
          value={view === "todos" ? (todoCal ?? "") : (calendarName ?? "")}
          aria-label={t("The calendar")}
          onChange={(e) => {
            const name = e.target.value;
            if (view === "todos") {
              setTodoCal(name);
              loadTodos(name || null);
            } else {
              setCalendarName(name);
            }
          }}
        >
          {calendars.map((c) => (
            <option key={c.name} value={c.name}>
              {c.displayName}
              {c.readOnly ? ` (${t("read-only")})` : ""}
            </option>
          ))}
        </select>
      )}

      {view === "events" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <button type="button" className={portal.ui.classes.ghost} onClick={() => setDay((d) => dayWord(shift(d, -7)))}>
              ← {t("seven days")}
            </button>
            <button type="button" className={portal.ui.classes.ghost} aria-label={t("Previous day")} onClick={() => setDay((d) => dayWord(shift(d, -1)))}>
              ‹
            </button>
            <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold">{dayLabel(day)}</span>
            <button type="button" className={portal.ui.classes.ghost} aria-label={t("Next day")} onClick={() => setDay((d) => dayWord(shift(d, 1)))}>
              ›
            </button>
            <button type="button" className={portal.ui.classes.ghost} onClick={() => setDay((d) => dayWord(shift(d, 7)))}>
              {t("seven days")} →
            </button>
          </div>

          {events === null ? (
            eventProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setEventProblem(null)}>{t("The events could not be read: {error}", { error: eventProblem })}</portal.ui.ErrorBanner>
            ) : (
              <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />
            )
          ) : events.length === 0 ? (
            <portal.ui.Empty>{t("Nothing is on this day.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-0.5">
              {events.map((e) => (
                <li key={e.uid}>
                  <button type="button" className="nc-event" onClick={() => openEvent(e)}>
                    <span className="min-w-0 flex-1 truncate text-left">
                      {e.summary}
                      {e.location !== undefined && <span className="text-fg-subtle"> — {e.location}</span>}
                    </span>
                    {!e.allDay && e.start !== undefined && (
                      <span className="shrink-0 text-xs text-fg-muted">{timeOfEvent(e)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="nc-form"
            onSubmit={(e) => {
              e.preventDefault();
              createEvent();
            }}
          >
            <p className="nc-form-title">{t("A new event on this day")}</p>
            <input className={portal.ui.classes.input} value={newTitle} placeholder={t("What it is")} aria-label={t("What it is")} onChange={(e) => setNewTitle(e.target.value)} />
            <div className="flex flex-wrap items-center gap-1">
              <label className="inline-flex items-center gap-1 text-xs">
                <input type="checkbox" checked={newAllDay} onChange={(e) => setNewAllDay(e.target.checked)} />
                {t("All day")}
              </label>
              {!newAllDay && (
                <>
                  <span className="text-xs text-fg-subtle">{t("From")}</span>
                  <input type="time" className={portal.ui.classes.inputSmall} value={newStartAt} aria-label={t("From")} onChange={(e) => setNewStartAt(e.target.value)} />
                  <span className="text-xs text-fg-subtle">{t("to")}</span>
                  <input type="time" className={portal.ui.classes.inputSmall} value={newEndAt} aria-label={t("To")} onChange={(e) => setNewEndAt(e.target.value)} />
                </>
              )}
            </div>
            <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newTitle.trim() === ""}>
              {t("Add")}
            </button>
          </form>
        </div>
      )}

      {view === "todos" && (
        <div className="space-y-2">
          {todos === null ? (
            todoProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setTodoProblem(null)}>{t("The todos could not be read: {error}", { error: todoProblem })}</portal.ui.ErrorBanner>
            ) : (
              <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />
            )
          ) : todos.length === 0 ? (
            <portal.ui.Empty>{t("Nothing is open here.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-0.5">
              {todos.map((td) => (
                <li key={td.uid}>
                  <div className="nc-item">
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => completeTodo(td)} aria-label={t("Tick this todo off")}>
                      ✓
                    </button>
                    <span className="nc-item-name min-w-0 flex-1 truncate">{td.summary}</span>
                    {td.due !== undefined && (
                      <span className="shrink-0 text-xs text-fg-subtle">
                        {(() => { const d = new Date(td.due); return Number.isNaN(d.getTime()) ? td.due : dayWord(d); })()}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {calendarProblem !== null && <portal.ui.ErrorBanner onClose={() => setCalendarProblem(null)}>{t("The calendars could not be read: {error}", { error: calendarProblem })}</portal.ui.ErrorBanner>}
    </div>
  );
}

/** The seven-day step from a day key, as a Date in the local noon (a day's shadow does not reach across it). */
function shift(key: string, by: number): Date {
  const d = new Date(`${key}T12:00`);
  d.setDate(d.getDate() + by);
  return d;
}

/** A day key as a row's words: the weekday short and its date. */
function dayLabel(key: string): string {
  const d = new Date(`${key}T12:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
}

/** The time one listed event starts at, in words for a row. */
function timeOfEvent(e: EventSummary): string {
  if (e.start === undefined) return "";
  const d = new Date(e.start);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
