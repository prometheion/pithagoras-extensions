import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";
import { confirmDelete } from "./widgets";

/** The Calendar tab: one month grid over all of the instance's calendars at once, every calendar a pill that
 * stands or steps away -- what Nextcloud's own sidebar means with its boxes. The events are held for a wide
 * window around today, so turning a month shows the days at once and only asks the server again where the
 * window ends. One day is opened to its agenda, one event to its detail (read, changed, taken away, new ones
 * made on any day into whichever calendar fits); recurring events are only listed with a note that changing
 * them stays in Nextcloud itself. And beside the events: the todos of every shown calendar together -- ticked
 * off, added and taken away. All of it as tool calls on the server. */

type Rec = Record<string, unknown>;

const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

interface CalendarRow {
  name: string; // the calendar's id in its own words
  displayName: string;
  color?: string;
  readOnly: boolean;
  enabled: boolean;
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
  calendarName: string; // whose it is: ticking and taking it away go back to that one
}

/** How many events one read asks for: a window that comes back full is said to be cut short. */
const EVENT_LIMIT = 500;
const pad = (n: number): string => String(n).padStart(2, "0");
/** A moment the tools gave as a word, as a Date. A bare day ("2025-03-15", what an all-day event carries) is that
 * day in the reader's own zone: `new Date("2025-03-15")` is UTC midnight, which west of Greenwich is still the 14th. */
export function parseWhen(word: string): Date {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word);
  return bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) : new Date(word);
}
/** A day in the tool's words from a Date. */
const dayWord = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The "YYYY-MM" word of a Date's month. */
const monthWord = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
/** A month word back to its first day, as a local noon (a day's shadow does not reach across it). */
const monthStart = (word: string): Date => new Date(`${word}-01T12:00`);
/** The last day of a Date's month. */
const monthEnd = (d: Date): Date => new Date(d.getFullYear(), d.getMonth() + 1, 0);
/** A Date shifted whole months, where the day holds as far as it can. */
const shiftMonth = (d: Date, by: number): Date => {
  const x = new Date(d);
  x.setDate(1); // a 31st would not survive the journey; the range only needs its edges
  x.setMonth(x.getMonth() + by);
  return x;
};
/** The cells of one month grid: Monday-first, just as many weeks as the month needs. */
function monthGrid(month: string): string[] {
  const first = monthStart(month);
  const lead = (first.getDay() + 6) % 7; // a JS Sunday is day 0 -- back to the Monday on or before it
  const tailDay = monthEnd(first).getDate();
  return Array.from({ length: Math.ceil((lead + tailDay) / 7) * 7 }, (_, i) => {
    const d = new Date(first);
    d.setDate(first.getDate() - lead + i);
    return dayWord(d);
  });
}
/** The weekday row, Monday-first, in the words the portal's language says (asked each time: the language may change). */
const weekdays = (): string[] => {
  const monday = new Date(2024, 0, 8); // a known Monday
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return portal.format.date(d, { weekday: "narrow" });
  });
};

/** An ISO word back to what a datetime-local input speaks -- or its date half alone for an all-day field. */
const localInput = (iso: string | undefined, dateOnly = false): string => {
  if (!iso) return "";
  const d = parseWhen(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A colour where the calendar did not give one: a quiet fixed wheel, found by the name so it stays put. */
const PALETTE = ["#d94f4f", "#e0a126", "#4ca34c", "#0f6bb5", "#8b5cf6", "#ef5c86", "#23587e", "#5f6b7a"];
function fallbackColor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return PALETTE[sum % PALETTE.length];
}

export default function Calendar() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the calendar calls go
  const [view, setView] = useState<"events" | "todos">("events");

  // the calendars and which of them are shown: a pill per one, standing where it is on, away where it is off
  const [calendars, setCalendars] = useState<CalendarRow[] | null>(null);
  const [calendarProblem, setCalendarProblem] = useState<string | null>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set());

  // the month it shows and the one day opened to its agenda below the grid
  const [month, setMonth] = useState<string>(() => monthWord(new Date()));
  const [selectedDay, setSelectedDay] = useState<string>(() => dayWord(new Date()));

  // everything of a wide window around today, held here: turning months inside it costs no call at all
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ from: string; to: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [eventProblem, setEventProblem] = useState<string | null>(null); // the events could not be read
  const [problem, setProblem] = useState<string | null>(null); // a change or an opening that failed, drawn whatever stands on screen
  const [showNew, setShowNew] = useState(false);

  // the one event open and its edit words as they stand (wall-clock words, what the input speaks)
  const [event, setEvent] = useState<EventFull | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editAllDay, setEditAllDay] = useState(false);
  const [startWord, setStartWord] = useState("");
  const [endWord, setEndWord] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [eventProblem2, setEventProblem2] = useState<string | null>(null);

  // the todo sub-view: what is open across the shown calendars and which one a new todo goes into
  const [todos, setTodos] = useState<TodoRow[] | null>(null);
  const [todoProblem, setTodoProblem] = useState<string | null>(null);
  const [newTodoCal, setNewTodoCal] = useState<string>("");

  // the new-event and new-todo forms: their words as they stand
  const [newTitle, setNewTitle] = useState("");
  // how long the new event stands: over a whole day or only inside a time span -- an either-or, no third word
  const [newMode, setNewMode] = useState<"day" | "time">("day");
  // how often it comes back: once is the quiet default; a week or a month makes it a series of itself
  const [newRecur, setNewRecur] = useState<"none" | "weekly" | "monthly">("none");
  const [newStartAt, setNewStartAt] = useState("09:00");
  const [newEndAt, setNewEndAt] = useState("10:00");
  const [todoPartial, setTodoPartial] = useState(0); // how many of the shown calendars did not answer their todos
  const [newCal, setNewCal] = useState<string>("");
  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [newTodoDue, setNewTodoDue] = useState("");

  const [busy, setBusy] = useState(false);
  const guard = useGuard();

  /** What the calendar list says: the pills, and a first guess where new things go. */
  const loadCalendars = () => {
    const current = guard("calendars");
    setCalendars(null);
    setCalendarProblem(null);
    void api
      .tool("nc_calendar_list_calendars", {}, instance)
      .then((result) => {
        if (!current()) return;
        const rows = (arrayOf(partText(result).data, "calendars") ?? []).map((c) => ({
          name: String(c.name),
          displayName: String(c.display_name ?? c.name),
          color: strOf(c.color),
          readOnly: Boolean(c.read_only),
          enabled: c.enabled === undefined ? true : Boolean(c.enabled),
        }));
        setCalendars(rows);
        setVisible(new Set(rows.filter((r) => r.enabled).map((r) => r.name))); // what stands, as Nextcloud has it standing
        const first = rows.find((r) => !r.readOnly && r.enabled) ?? rows[0];
        if (first !== undefined) {
          setNewCal(first.name);
          setNewTodoCal(first.name);
        }
      })
      .catch((error) => current() && setCalendarProblem(sayError(error)));
  };

  useEffect(() => {
    loadCalendars();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The events of one wide window at once, across every calendar: the grid and the agenda share it. */
  const fetchWindow = (m: string) => {
    const current = guard("events");
    const first = monthStart(m);
    const from = dayWord(shiftMonth(first, -4)); // back four months...
    const to = dayWord(monthEnd(shiftMonth(first, 8))); // ...and on eight: most of the turning stays inside
    setEventProblem(null);
    setLoading(true);
    void api
      .tool(
        "nc_calendar_list_events",
        { calendar_name: "", search_all_calendars: true, start_date: from, end_date: to, limit: EVENT_LIMIT },
        instance
      )
      .then((result) => {
        if (!current()) return;
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
        setLoadedRange({ from, to });
      })
      .catch((error) => current() && setEventProblem(sayError(error)))
      .finally(() => current() && setLoading(false));
  };

  /** Whether the window already covers the shown month: where it does, no call goes out at all. */
  const covered = (m: string): boolean => {
    if (loadedRange === null) return false;
    return loadedRange.from <= dayWord(monthStart(m)) && loadedRange.to >= dayWord(monthEnd(monthStart(m)));
  };

  useEffect(() => {
    if (!covered(month)) fetchWindow(month);
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  /** After a change: the window asks again for what it holds, so the grid stands true. The events on screen stay
   * while it comes. */
  const refresh = () => {
    setLoadedRange(null);
    fetchWindow(month);
  };

  /** The shown events: only what a standing calendar says is on them; an event without a name keeps its place. */
  const shownEvents = useMemo(
    () => (events ?? []).filter((e) => e.calendarName === undefined || visible.has(e.calendarName)),
    [events, visible]
  );

  /** The window's events under every day they stand on -- from the day they start to the day they end (an all-day
   * event's end is the day after its last, an event that ends at midnight ends the day before) -- all-day first in
   * each day, then by start. */
  const byDay = useMemo(() => {
    const map: Record<string, EventSummary[]> = {};
    for (const e of shownEvents) {
      if (e.start === undefined) continue;
      const first = parseWhen(e.start);
      if (Number.isNaN(first.getTime())) continue;
      const end = e.end !== undefined ? parseWhen(e.end) : undefined;
      const last = new Date(first.getFullYear(), first.getMonth(), first.getDate());
      if (end !== undefined && !Number.isNaN(end.getTime()) && end > first) {
        const stop = new Date(end);
        const midnight = stop.getHours() === 0 && stop.getMinutes() === 0 && stop.getSeconds() === 0;
        if (e.allDay || midnight) stop.setDate(stop.getDate() - 1);
        if (stop >= last) last.setTime(new Date(stop.getFullYear(), stop.getMonth(), stop.getDate()).getTime());
      }
      const day = new Date(first.getFullYear(), first.getMonth(), first.getDate());
      for (let n = 0; day <= last && n < 62; n++) {
        (map[dayWord(day)] ??= []).push(e);
        day.setDate(day.getDate() + 1);
      }
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => Number(b.allDay) - Number(a.allDay) || String(a.start ?? "").localeCompare(String(b.start ?? "")));
    }
    return map;
  }, [shownEvents]);

  /** What a calendar stands out in its chip: its own colour, or the wheel's where it has none. */
  const colorOf = (name?: string): string => {
    if (name === undefined) return "var(--fg-muted)";
    return calendars?.find((c) => c.name === name)?.color ?? fallbackColor(name);
  };

  const stepMonth = (by: number) => {
    const d = monthStart(month);
    d.setMonth(d.getMonth() + by);
    setMonth(monthWord(d));
  };

  /** A day of the grid, opened to its agenda -- a neighbour-month day turns the month with it. */
  const pickDay = (key: string) => {
    setSelectedDay(key);
    if (key.slice(0, 7) !== month) setMonth(key.slice(0, 7));
  };

  /** Where an event's words stand and fall back: its own calendar first, then the first standing one. */
  const homeOf = (e?: { calendarName?: string }): string | null =>
    e?.calendarName ?? [...visible].find((n) => calendars?.some((c) => c.name === n && !c.readOnly)) ?? calendars?.[0]?.name ?? null;

  const openEvent = (summary: EventSummary) => {
    const home = homeOf(summary);
    if (home === null || busy) return;
    const current = guard("event");
    setEvent(null);
    setEventProblem2(null);
    setProblem(null);
    void api
      .tool("nc_calendar_get_event", { calendar_name: home, event_uid: summary.uid }, instance)
      .then((result) => {
        if (!current()) return;
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
        setStartWord(localInput(strOf(r.start), allDay));
        setEndWord(localInput(strOf(r.end), false));
        setEditDescription(strOf(r.description) ?? "");
        setEditLocation(strOf(r.location) ?? "");
      })
      .catch((error) => current() && setProblem(sayError(error)));
  };

  /** What the open event's words change against the event, as the update tool takes them -- or why they cannot be sent. */
  const eventChanges = (): { args: Rec; changed: boolean; error?: string } => {
    const home = event === null ? null : homeOf(event);
    if (event === null || home === null) return { args: {}, changed: false };
    const args: Rec = { calendar_name: home, event_uid: event.uid };
    let changed = false;
    let error: string | undefined;
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
    const timesChanged = editAllDay !== event.allDay || startWord !== originalStart || endWord !== originalEnd;
    if (timesChanged) {
      // the wall-clock words back to what the tools take: a day-only word is an all-day word with midnight on
      // the tools take an all-day event's word as a day alone ("2025-01-15"), a timed one with its clock on
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(startWord);
      if (startWord === "") error = t("Give the event a start.");
      const startIso = startWord === "" ? undefined : dateOnly ? (editAllDay ? startWord : `${startWord}T00:00`) : `${startWord}:00`;
      if (startIso !== undefined) args.start_datetime = startIso;
      if (!editAllDay && endWord !== "" && !/\d{4}-\d{2}-\d{2}$/.test(endWord)) {
        const endD = new Date(`${endWord}:00`);
        const startD = new Date(startIso ?? "");
        if (!Number.isNaN(endD.getTime()) && !Number.isNaN(startD.getTime())) {
          if (endD > startD) args.end_datetime = `${endWord}:00`;
          else error = t("The event ends before it starts.");
        }
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
    return { args, changed, error };
  };
  const eventDirty = event !== null && !event.recurring && eventChanges().changed;
  portal.ui.useUnsavedDraft(eventDirty || (showNew && newTitle.trim() !== ""));

  const saveEvent = () => {
    const { args, changed, error } = eventChanges();
    if (event === null || !changed) return;
    if (error !== undefined) {
      setEventProblem2(error); // said, and the form stays: nothing is dropped without a word
      return;
    }
    void (async () => {
      setBusy(true);
      setEventProblem2(null);
      try {
        await api.tool("nc_calendar_update_event", args, instance);
        setEvent(null);
        refresh();
      } catch (error) {
        setEventProblem2(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const backToAgenda = async () => {
    if (eventDirty && !(await portal.ui.confirm({ title: t("Leave this event without saving?"), message: t("What you changed in it is lost."), confirmLabel: t("Leave"), danger: true }))) return;
    setEvent(null);
  };

  const deleteEvent = async () => {
    if (event === null) return;
    const home = homeOf(event);
    if (home === null) return;
    if (!(await confirmDelete(t("Take this event away for good?"), event.summary, t("Delete this event")))) return;
    setBusy(true);
    setEventProblem2(null);
    try {
      await api.tool("nc_calendar_delete_event", { calendar_name: home, event_uid: event.uid }, instance);
      setEvent(null);
      refresh();
    } catch (error) {
      setEventProblem2(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const createEvent = () => {
    if (newCal === "" || newTitle.trim() === "") return;
    void (async () => {
      setBusy(true);
      setProblem(null);
      try {
        const allDay = newMode === "day";
        const start = new Date(`${selectedDay}T${allDay ? "00:00" : newStartAt}`);
        if (Number.isNaN(start.getTime())) throw new Error(t("The day of the new event could not be read."));
        const args: Rec = {
          calendar_name: newCal,
          title: newTitle.trim(),
          start_datetime: allDay ? selectedDay : `${selectedDay}T${newStartAt}:00`, // a day alone is the tool's all-day word
          all_day: allDay,
        };
        if (!allDay) {
          const end = new Date(`${selectedDay}T${newEndAt}:00`);
          if (Number.isNaN(end.getTime()) || end <= start) throw new Error(t("The event ends before it starts."));
          args.end_datetime = `${selectedDay}T${newEndAt}:00`;
        }
        if (newRecur !== "none") {
          // The series stands in its rule: weekly without a weekday letter repeats every seven days from the
          // first, monthly on the same day of each month. (A weekday letter in the rule trips the server's
          // time-zone read, which is why none goes in here.)
          args.recurring = true;
          args.rrule = newRecur === "weekly" ? { freq: "WEEKLY", interval: 1 } : { freq: "MONTHLY", interval: 1 };
        }
        await api.tool("nc_calendar_create_event", args, instance);
        setNewTitle("");
        setNewRecur("none");
        setShowNew(false);
        refresh();
      } catch (error) {
        setProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  /** The todos of every shown calendar at once: one call per calendar, what a single one could not. */
  const loadTodos = (names: string[], keep = false) => {
    const current = guard("todos");
    if (names.length === 0) {
      setTodos([]);
      return;
    }
    if (!keep) setTodos(null);
    setTodoProblem(null);
    setTodoPartial(0);
    void Promise.allSettled(
      names.map((name) => api.tool("nc_calendar_list_todos", { calendar_name: name }, instance))
    ).then((results) => {
      if (!current()) return;
      const rows: TodoRow[] = [];
      let answered = 0;
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        answered++;
        const data = partText(r.value).data;
        const list = typeof data === "object" && data !== null ? (data as Rec).todos : undefined;
        if (!Array.isArray(list)) return;
        for (const td of list) {
          const s = String((td as Rec).status ?? "NEEDS-ACTION").toUpperCase();
          if (s === "COMPLETED" || s === "CANCELLED") continue; // only what is still open stands here
          const o = td as Rec;
          rows.push({ uid: String(o.uid ?? ""), summary: String(o.summary ?? ""), due: strOf(o.due), calendarName: names[i] });
        }
      });
      rows.sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")) || a.summary.localeCompare(b.summary));
      if (answered === 0) {
        setTodoProblem(t("The todos could not be read."));
        return;
      }
      setTodoPartial(names.length - answered);
      setTodos(rows);
    });
  };

  const todoKey = [...visible].sort().join("|");
  useEffect(() => {
    if (view === "todos" && calendars !== null) loadTodos(todoKey === "" ? [] : todoKey.split("|"));
  }, [view, todoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const completeTodo = (todo: TodoRow) => {
    if (busy) return;
    void (async () => {
      setBusy(true);
      try {
        await api.tool("nc_calendar_complete_todo", { calendar_name: todo.calendarName, todo_uid: todo.uid }, instance); // its own now is the timestamp
        loadTodos(todoKey === "" ? [] : todoKey.split("|"), true);
      } catch (error) {
        setTodoProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const deleteTodo = async (todo: TodoRow) => {
    if (busy) return;
    if (!(await confirmDelete(t("Take this todo away for good?"), todo.summary, t("Delete")))) return;
    setBusy(true);
    try {
      await api.tool("nc_calendar_delete_todo", { calendar_name: todo.calendarName, todo_uid: todo.uid }, instance);
      loadTodos(todoKey === "" ? [] : todoKey.split("|"), true);
    } catch (error) {
      setTodoProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const createTodo = () => {
    if (newTodoCal === "" || newTodoTitle.trim() === "") return;
    void (async () => {
      setBusy(true);
      try {
        const args: Rec = { calendar_name: newTodoCal, summary: newTodoTitle.trim() };
        if (newTodoDue !== "") args.due = newTodoDue; // a day alone is the tool's all-day word
        await api.tool("nc_calendar_create_todo", args, instance);
        setNewTodoTitle("");
        setNewTodoDue("");
        loadTodos(todoKey === "" ? [] : todoKey.split("|"), true);
      } catch (error) {
        setTodoProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const todayKey = dayWord(new Date());
  const agenda = byDay[selectedDay] ?? [];
  const cells = monthGrid(month); // the grid's days, counted once so the rows may claim their share of the height
  const weekCount = Math.ceil(cells.length / 7);

  /** Whether the panel really has room for a taller calendar is only something the panel can answer -- so ask
   * it directly: what stands above the grid and what below it inside its scroller. Where more than the rows'
   * floor remains, the grid takes that much height; where none does, it stays on the floor and nothing scrolls
   * up a row taller than before. (Stands where every hook of this component stands: one before any of the
   * returns below decides which tree is drawn at all -- where the detail view used to return first, React
   * counted fewer hooks and threw out of the page with it.) */
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (view !== "events" || events === null) return;
    const grid = gridRef.current; // where the detail view stands, no grid is drawn at all
    if (grid === null) return;
    let scroller: HTMLElement | null = null; // the panel's own scrolling box stands somewhere above the grid
    for (let el = grid.parentElement; el instanceof HTMLElement; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if (o === "auto" || o === "scroll") {
        scroller = el;
        break;
      }
    }
    if (scroller === null || scroller.clientHeight <= 0) return;
    const box = scroller; // the closure may not doubt it
    const size = () => {
      const g = grid.getBoundingClientRect();
      const s = box.getBoundingClientRect();
      let below = 0; // what stands under the grid in its section: agenda, forms -- their space is not to take
      for (let sib = grid.nextElementSibling as HTMLElement | null; sib instanceof HTMLElement; sib = sib.nextElementSibling as HTMLElement | null) {
        below += sib.offsetHeight + 8; // the section's own spacing stands between them
      }
      const topUsed = g.top - s.top + box.scrollTop;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const minH = weekCount * 3.4 * rem;
      const avail = box.clientHeight - topUsed - below - 8;
      grid.style.height = avail > minH ? `${Math.floor(avail)}px` : "";
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(box);
    return () => {
      ro.disconnect();
      grid.style.height = "";
    };
  }, [view, events, month, showNew, selectedDay, calendars, weekCount, problem]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- what is drawn -------------------------------------------------------

  if (event !== null) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => void backToAgenda()}>
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
          <p className="rounded-md border px-2 py-1 text-xs text-fg-muted" style={{ borderColor: "rgb(var(--line))", background: "rgb(var(--raised))" }}>
            {t("This is a recurring event. Changing it stays in Nextcloud itself.")}
          </p>
        )}
        <input className={portal.ui.classes.input} value={editTitle} aria-label={t("Event title")} disabled={event.recurring} onChange={(e) => setEditTitle(e.target.value)} />
        <div className="flex flex-wrap items-center gap-1">
          {/* The span of the event as an either-or, like the new one stands chosen: whole day or a time span. */}
          <portal.ui.Segments
            label={t("How long it stands")}
            size="sm"
            value={editAllDay ? "day" : "time"}
            options={[
              { id: "day", label: t("All day") },
              { id: "time", label: t("A time span") },
            ]}
            onChange={(id) => {
              if (event.recurring) return;
              if (id === "day") {
                setEditAllDay(true);
                // the start field keeps one consistent word: a day alone where it turns all-day
                if (/^\d{4}-\d{2}-\d{2}T/.test(startWord)) setStartWord(startWord.slice(0, 10));
              } else {
                setEditAllDay(false);
                // ...and back to a wall clock from nine to ten where the words only knew their day: the end of an
                // all-day event is the day after its last, which is no end for a time span
                const day = startWord.slice(0, 10);
                if (/^\d{4}-\d{2}-\d{2}$/.test(startWord)) setStartWord(`${day}T09:00`);
                if (day !== "") setEndWord(`${day}T10:00`);
              }
            }}
          />
          {editAllDay ? (
            <input type="date" className={portal.ui.classes.inputSmall} value={startWord} aria-label={t("On which day")} disabled={event.recurring} onChange={(e) => setStartWord(e.target.value)} />
          ) : (
            <>
              <span className="text-xs text-fg-subtle">{t("From")}</span>
              <input type="datetime-local" className={portal.ui.classes.inputSmall} value={startWord} aria-label={t("From")} disabled={event.recurring} onChange={(e) => setStartWord(e.target.value)} />
              <span className="text-xs text-fg-subtle">{t("to")}</span>
              <input type="datetime-local" className={portal.ui.classes.inputSmall} value={endWord} aria-label={t("To")} disabled={event.recurring} onChange={(e) => setEndWord(e.target.value)} />
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
    <div className="calendar-pane space-y-2">
      <portal.ui.Segments
        label={t("What the calendar shows")}
        size="sm"
        value={view}
        options={[
          { id: "events", label: t("Events") },
          { id: "todos", label: t("Todos") },
        ]}
        onChange={setView}
      />
      {problem !== null && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}

      {/* The calendars as pills: what is on stands out, what is off steps back; together they are the view. */}
      {calendars !== null && calendars.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {calendars.map((c) => {
            const on = visible.has(c.name);
            return (
              <button
                key={c.name}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setVisible((old) => {
                    const next = new Set(old);
                    if (next.has(c.name)) next.delete(c.name);
                    else next.add(c.name);
                    return next;
                  })
                }
                className={`nc-calpill${on ? "" : " nc-calpill-off"}`}
                style={on ? { backgroundColor: `color-mix(in srgb, ${colorOf(c.name)} 16%, transparent)` } : undefined}
              >
                <span aria-hidden className="nc-caldot" style={{ background: colorOf(c.name) }} />
                {c.displayName}
                {c.readOnly ? ` (${t("read-only")})` : ""}
              </button>
            );
          })}
        </div>
      )}

      {view === "events" && (
        <div className="calendar-events space-y-2">
          <div className="flex items-center gap-1">
            <button type="button" className={portal.ui.classes.ghost} aria-label={t("Previous month")} onClick={() => stepMonth(-1)}>
              ‹
            </button>
            <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold" aria-live="polite">{monthLabel(month)}</span>
            <button type="button" className={portal.ui.classes.ghost} aria-label={t("Next month")} onClick={() => stepMonth(1)}>
              ›
            </button>
            <button type="button" className={portal.ui.classes.ghost} onClick={() => { setMonth(monthWord(new Date())); setSelectedDay(dayWord(new Date())); }}>
              {t("Today")}
            </button>
          </div>

          {events === null ? (
            eventProblem !== null ? (
              <portal.ui.LoadFailed error={t("The events could not be read: {error}", { error: eventProblem })} onRetry={() => fetchWindow(month)} />
            ) : (
              <portal.ui.RowsSkeleton rows={6} label={t("Loading…")} />
            )
          ) : (
            <>
              {loading && <p className="text-xs text-fg-subtle">{t("The days are being asked for again…")}</p>}
              {eventProblem !== null && <portal.ui.ErrorBanner onClose={() => setEventProblem(null)}>{t("The events could not be read: {error}", { error: eventProblem })}</portal.ui.ErrorBanner>}
              {events.length >= EVENT_LIMIT && <p className="text-xs text-fg-subtle">{t("Showing the first {n} events of the months around this one: there are more.", { n: EVENT_LIMIT })}</p>}
              <div ref={gridRef} className="nc-monthgrid" style={{ gridTemplateRows: `auto repeat(${weekCount}, minmax(3.4rem, 1fr))` }}>
                {weekdays().map((w, i) => (
                  <span key={i} className="nc-monthhead">{w}</span>
                ))}
                {cells.map((key) => {
                  const dayEvents = byDay[key] ?? [];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => pickDay(key)}
                      aria-label={dayEvents.length > 0 ? t("Open the day {day}, with {n} events: {titles}", { day: dayLabel(key), n: dayEvents.length, titles: dayEvents.map((e) => e.summary).join(", ") }) : t("Open the day {day}", { day: dayLabel(key) })}
                      className={`nc-monthcell${key.slice(0, 7) !== month ? " nc-monthcell-out" : ""}${key === selectedDay ? " nc-monthcell-on" : ""}${key === todayKey ? " nc-monthcell-today" : ""}`}
                    >
                      <span className="nc-monthnum">{Number(key.slice(8))}</span>
                      {dayEvents.length > 0 && (
                        <span className="nc-monthevs">
                          {dayEvents.slice(0, 3).map((e) => (
                            <span key={e.uid} className={`nc-monthchip${e.allDay ? " nc-monthchip-all" : ""}`} style={{ backgroundColor: `color-mix(in srgb, ${colorOf(e.calendarName)} 22%, transparent)` }}>
                              {e.summary}
                            </span>
                          ))}
                          {dayEvents.length > 3 && <span className="nc-monthmore">+{dayEvents.length - 3}</span>}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {events !== null && (
            <>
              <div className="flex items-center gap-1">
                <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => setShowNew((s) => !s)}>
                  {showNew ? "−" : "+"} {t("New event")}
                </button>
                <span className="flex-1" />
                <span className="text-xs text-fg-subtle">{dayLabel(selectedDay)}</span>
              </div>

              {agenda.length === 0 ? (
                <portal.ui.Empty>{t("Nothing is on this day.")}</portal.ui.Empty>
              ) : (
                <ul className="space-y-0.5">
                  {agenda.map((e) => (
                    <li key={e.uid}>
                      <button type="button" className="nc-event" onClick={() => openEvent(e)} title={calendars?.find((c) => c.name === e.calendarName)?.displayName ?? e.calendarName ?? ""}>
                        <span aria-hidden className="nc-caldot" style={{ background: colorOf(e.calendarName) }} />
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

              {showNew && (
                <form
                  className="nc-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    createEvent();
                  }}
                >
                  <p className="nc-form-title">{t("A new event on this day")}</p>
                  <input className={portal.ui.classes.input} value={newTitle} placeholder={t("What it is")} aria-label={t("What it is")} onChange={(e) => setNewTitle(e.target.value)} />
                  {calendars !== null && calendars.length > 0 && (
                    <portal.ui.Select
                      size="sm"
                      className="w-full"
                      value={newCal}
                      aria-label={t("Into which calendar")}
                      onChange={(name) => setNewCal(name)}
                      options={calendars.map((c) => ({
                        value: c.name,
                        label: c.displayName + (c.readOnly ? ` (${t("read-only")})` : ""),
                      }))}
                    />
                  )}
                  {/* All day or a time span: one of the two, chosen as an either-or. Where the choice turns to hours, they
                      stand in a row below with their own words above. */}
                  <portal.ui.Segments
                    label={t("How long it stands")}
                    size="sm"
                    value={newMode}
                    options={[
                      { id: "day", label: t("All day") },
                      { id: "time", label: t("A time span") },
                    ]}
                    onChange={setNewMode}
                  />
                  {/* The hours get a row of their own under the choice, so they can never crowd it: two labeled
                      fields that stretch to the room there is, which keeps their numbers whole at any width. */}
                  {newMode === "time" && (
                    <div className="grid grid-cols-2 gap-1">
                      <label className="flex flex-col text-xs" style={{ gap: "0.2rem" }}>
                        {t("From")}
                        <input type="time" className={portal.ui.classes.inputSmall} value={newStartAt} aria-label={t("From")} onChange={(e) => setNewStartAt(e.target.value)} />
                      </label>
                      <label className="flex flex-col text-xs" style={{ gap: "0.2rem" }}>
                        {t("To")}
                        <input type="time" className={portal.ui.classes.inputSmall} value={newEndAt} aria-label={t("To")} onChange={(e) => setNewEndAt(e.target.value)} />
                      </label>
                    </div>
                  )}
                  {/* How often it comes back: the same either-or, here with three words -- once is what most days are,
                      week and month make of the one a series. */}
                  <portal.ui.Segments
                    label={t("How often it comes back")}
                    size="sm"
                    value={newRecur}
                    options={[
                      { id: "none", label: t("Once") },
                      { id: "weekly", label: t("Weekly") },
                      { id: "monthly", label: t("Monthly") },
                    ]}
                    onChange={setNewRecur}
                  />
                  {newRecur !== "none" && (
                    <p className="text-xs text-fg-subtle">
                      {newRecur === "weekly" ? t("Every seven days from its first day.") : t("On this day of each month, starting at its first day.")}
                    </p>
                  )}
                  <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newTitle.trim() === ""}>
                    {t("Add")}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}

      {view === "todos" && (
        <div className="space-y-2">
          {todos === null ? (
            todoProblem !== null ? (
              <portal.ui.LoadFailed error={todoProblem} onRetry={() => loadTodos(todoKey === "" ? [] : todoKey.split("|"))} />
            ) : (
              <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />
            )
          ) : todos.length === 0 ? (
            <>
              {todoPartial > 0 && <p className="text-xs text-fg-subtle">{t("{n} of the calendars did not answer: their todos are missing.", { n: todoPartial })}</p>}
              <portal.ui.Empty>{t("Nothing is open here.")}</portal.ui.Empty>
            </>
          ) : (
            <ul className="space-y-0.5">
              {todoPartial > 0 && <li className="text-xs text-fg-subtle">{t("{n} of the calendars did not answer: their todos are missing.", { n: todoPartial })}</li>}
              {todos.map((td) => (
                <li key={td.calendarName + td.uid}>
                  <div className="nc-item">
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => completeTodo(td)} aria-label={t("Tick this todo off")}>
                      ✓
                    </button>
                    <span aria-hidden className="nc-caldot" style={{ background: colorOf(td.calendarName) }} />
                    <span className="nc-item-name min-w-0 flex-1 truncate">{td.summary}</span>
                    {td.due !== undefined && (
                      <span className="shrink-0 text-xs text-fg-subtle">
                        {(() => { const d = parseWhen(td.due); return Number.isNaN(d.getTime()) ? td.due : portal.format.date(d, { day: "2-digit", month: "short" }); })()}
                      </span>
                    )}
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => deleteTodo(td)} aria-label={t("Take this todo away")}>
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form
            className="nc-form"
            onSubmit={(e) => {
              e.preventDefault();
              createTodo();
            }}
          >
            <p className="nc-form-title">{t("A new todo")}</p>
            <input className={portal.ui.classes.input} value={newTodoTitle} placeholder={t("What is to do")} aria-label={t("What is to do")} onChange={(e) => setNewTodoTitle(e.target.value)} />
            {calendars !== null && calendars.length > 0 && (
              <portal.ui.Select
                size="sm"
                className="w-full"
                value={newTodoCal}
                aria-label={t("Into which calendar")}
                onChange={(name) => setNewTodoCal(name)}
                options={calendars.map((c) => ({
                  value: c.name,
                  label: c.displayName + (c.readOnly ? ` (${t("read-only")})` : ""),
                }))}
              />
            )}
            <div className="flex items-center gap-1">
              <span className="text-xs text-fg-subtle">{t("Due")}</span>
              <input type="date" className={portal.ui.classes.inputSmall} value={newTodoDue} aria-label={t("Due")} onChange={(e) => setNewTodoDue(e.target.value)} />
            </div>
            <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newTodoTitle.trim() === ""}>
              {t("Add")}
            </button>
          </form>
        </div>
      )}

      {calendarProblem !== null && <portal.ui.LoadFailed error={t("The calendars could not be read: {error}", { error: calendarProblem })} onRetry={loadCalendars} />}
    </div>
  );
}

/** A month key as its row's words: the month long and its year, in the portal's language. */
function monthLabel(key: string): string {
  return portal.format.date(monthStart(key), { month: "long", year: "numeric" });
}

/** A day key as a row's words: the weekday short and its date. */
function dayLabel(key: string): string {
  const d = new Date(`${key}T12:00`);
  if (Number.isNaN(d.getTime())) return key;
  return portal.format.date(d, { weekday: "short", day: "2-digit", month: "short" });
}

/** The time one listed event starts at, in words for a row. */
function timeOfEvent(e: EventSummary): string {
  if (e.start === undefined) return "";
  const d = parseWhen(e.start);
  if (Number.isNaN(d.getTime())) return "";
  return portal.format.time(d, { hour: "2-digit", minute: "2-digit" });
}
