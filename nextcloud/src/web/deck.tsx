import { useEffect, useState } from "react";
import { LuPlus } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The Deck tab: one board chosen of the boards; its stacks with their cards; and one card open to its detail --
 * read, renamed or reworded, due-dated, marked done, moved to another stack or taken away. What the deck tools
 * give is what this view shows; the rest of Deck stays in Nextcloud itself. All of it as a tool call on the server. */

type Rec = Record<string, unknown>;

const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const numOf = (value: unknown): number | undefined => (typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : undefined);

interface BoardRow {
  id: number;
  title: string;
  color?: string;
}
interface LabelChip {
  title: string;
  color?: string;
}
interface CardMini {
  id: number;
  title: string;
  duedate?: string;
  done: boolean;
  labels: LabelChip[];
}
interface StackRow {
  id: number;
  title: string;
  cards: CardMini[];
}
/** One card read in full by the get-card tool. */
interface CardFull extends CardMini {
  description?: string;
  startdate?: string;
  assignedUsers?: string[];
  url?: string;
}

/** The date-and-time words a datetime-local input speaks, from an ISO word (and back to what the tools want: the
 * same wall-clock word, which Nextcloud reads in its own time). */
const toInput = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const showDate = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
};

const mapCard = (c: Rec): CardMini => ({
  id: Number(c.id ?? 0),
  title: String(c.title ?? ""),
  duedate: strOf(c.duedate),
  done: Boolean(c.done),
  // a card listed in its short form carries its labels as bare names; read in full they come with their colour
  labels: (Array.isArray(c.labels) ? c.labels : []).map((l) =>
    typeof l === "string" ? { title: l, color: undefined } : { title: String((l as Rec).title ?? ""), color: strOf((l as Rec).color) }
  ),
});

export default function Deck() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the deck calls go
  const [boards, setBoards] = useState<BoardRow[] | null>(null);
  const [boardProblem, setBoardProblem] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<number | null>(null);
  const [stacks, setStacks] = useState<StackRow[] | null>(null);
  const [stackProblem, setStackProblem] = useState<string | null>(null);

  // the one card open, and its edit words as they stand
  const [card, setCard] = useState<CardFull | null>(null);
  const [cardInStack, setCardInStack] = useState<number | null>(null);
  const [cardProblem, setCardProblem] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDue, setEditDue] = useState("");

  // the new card form: which stack it goes into and its words
  const [newStackId, setNewStackId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDue, setNewDue] = useState("");

  const [moveTo, setMoveTo] = useState<number | null>(null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBoards = () => {
    setBoards(null);
    setBoardProblem(null);
    void api
      .tool("deck_get_boards", {}, instance)
      .then((result) => {
        const rows = (arrayOf(partText(result).data, "boards") ?? []).map((b) => ({ id: Number(b.id), title: String(b.title ?? ""), color: strOf(b.color) }));
        setBoards(rows);
        if (rows.length > 0 && boardId === null) chooseBoard(rows[0].id);
      })
      .catch((error) => setBoardProblem(sayError(error)));
  };

  useEffect(() => {
    loadBoards();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadStacks = (id: number) => {
    setStacks(null);
    setStackProblem(null);
    void api
      .tool("deck_get_stacks", { board_id: id, include_cards: true }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? (data as Rec).stacks : undefined;
        setStacks(
          Array.isArray(list)
            ? list.map((s) => {
                const r = s as Rec;
                return { id: Number(r.id), title: String(r.title ?? ""), cards: (Array.isArray(r.cards) ? r.cards : []).map(mapCard) };
              })
            : []
        );
      })
      .catch((error) => setStackProblem(sayError(error)));
  };

  const chooseBoard = (id: number) => {
    setBoardId(id);
    setCard(null);
    setNewStackId(null);
    loadStacks(id);
  };

  const openCard = (stackId: number, mini: CardMini) => {
    if (boardId === null || busy) return;
    setCard(null);
    setCardProblem(null);
    setMoveTo(null);
    void api
      .tool("deck_get_card", { board_id: boardId, stack_id: stackId, card_id: mini.id }, instance)
      .then((result) => {
        const data = partText(result).data;
        if (typeof data !== "object" || data === null) throw new Error(t("The card did not answer in a way this panel reads."));
        const r = data as Rec;
        const full: CardFull = {
          ...mapCard(r),
          description: strOf(r.description),
          startdate: strOf(r.startdate),
          // the tool answers an assignment either as a bare uid, or as a user -- sometimes wrapped in its participant
          assignedUsers: (Array.isArray(r.assignedUsers) ? r.assignedUsers : []).map((u) =>
            String(typeof u === "object" && u !== null ? (((u as Rec).participant as Rec | undefined)?.displayname ?? (u as Rec).displayname ?? (u as Rec).uid ?? "") : u)
          ),
          url: strOf(r.url),
        };
        setCard(full);
        setCardInStack(stackId);
        setEditTitle(full.title);
        setEditDescription(full.description ?? "");
        setEditDue(toInput(full.duedate));
      })
      .catch((error) => setCardProblem(sayError(error)));
  };

  const act = async (fn: () => Promise<unknown>, then?: () => void) => {
    if (busy || boardId === null) return;
    setBusy(true);
    setActionProblem(null);
    try {
      await fn();
      then?.();
    } catch (error) {
      setActionProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveCard = () => {
    if (card === null || cardInStack === null || boardId === null) return;
    const args: Rec = { board_id: boardId, stack_id: cardInStack, card_id: card.id };
    let changed = false;
    if (editTitle.trim() !== "" && editTitle !== card.title) {
      args.title = editTitle.trim();
      changed = true;
    }
    if (editDescription !== (card.description ?? "")) {
      args.description = editDescription;
      changed = true;
    }
    const originalDue = toInput(card.duedate);
    if (editDue !== originalDue) {
      // an empty word is how the tool clears a due date (a null would keep it); a wall-clock word, which Nextcloud reads in its own time
      args.duedate = editDue === "" ? "" : `${editDue}:00`;
      changed = true;
    }
    if (!changed) return;
    void act(() => api.tool("deck_update_card", args, instance), () => openCard(cardInStack, card));
  };

  // the tools stamp a completion date on; they give no word to take it off again
  const markDone = () => {
    if (card === null || cardInStack === null || boardId === null) return;
    void act(
      () => api.tool("deck_update_card", { board_id: boardId, stack_id: cardInStack, card_id: card.id, done: new Date().toISOString() }, instance),
      () => openCard(cardInStack, card)
    );
  };

  const moveCard = (targetStackId: number) => {
    if (card === null || cardInStack === null || boardId === null || targetStackId === cardInStack) return;
    void act(
      () => api.tool("deck_reorder_card", { board_id: boardId, stack_id: cardInStack, card_id: card.id, order: 999, target_stack_id: targetStackId }, instance),
      () => {
        setCard(null);
        loadStacks(boardId);
      }
    );
  };

  const deleteCard = () => {
    if (card === null || cardInStack === null || boardId === null) return;
    if (!window.confirm(t("Take this card away for good?"))) return;
    void act(
      () => api.tool("deck_delete_card", { board_id: boardId, stack_id: cardInStack, card_id: card.id }, instance),
      () => {
        setCard(null);
        loadStacks(boardId);
      }
    );
  };

  const createCard = () => {
    if (boardId === null || newStackId === null || newTitle.trim() === "") return;
    const args: Rec = { board_id: boardId, stack_id: newStackId, title: newTitle.trim() };
    if (newDescription !== "") args.description = newDescription;
    if (newDue !== "") args.duedate = `${newDue}:00`;
    void act(
      () => api.tool("deck_create_card", args, instance),
      () => {
        setNewTitle("");
        setNewDescription("");
        setNewDue("");
        loadStacks(boardId);
      }
    );
  };

  // ---- what is drawn -------------------------------------------------------

  if (card !== null) {
    const otherStacks = (stacks ?? []).filter((s) => s.id !== cardInStack);
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setCard(null)}>
            ← {t("Back to the board")}
          </button>
          <span className="flex-1" />
          {card.done ? (
            <span className="shrink-0 text-xs font-semibold" style={{ color: "rgb(var(--accent))" }}>{t("done")}</span>
          ) : (
            <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={markDone}>
              {t("Mark done")}
            </button>
          )}
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void deleteCard()}>
            {t("Delete this card")}
          </button>
        </div>

        {card === null ? null : (
          <>
            {(card.labels.length > 0 || (card.assignedUsers ?? []).length > 0) && (
              <div className="flex flex-wrap items-center gap-1">
                {card.labels.map((label) => (
                  <span key={label.title} className="nc-chip" style={label.color !== undefined ? { background: label.color, color: "#fff", borderColor: label.color } : undefined}>
                    {label.title}
                  </span>
                ))}
                {(card.assignedUsers ?? []).filter((name) => name !== "").map((name) => (
                  <span key={name} className="nc-chip nc-chip-dim" title={t("Assigned to")}>
                    {name}
                  </span>
                ))}
              </div>
            )}
            <input className={portal.ui.classes.input} value={editTitle} aria-label={t("Card title")} onChange={(e) => setEditTitle(e.target.value)} />
            <textarea className="nc-note-text" rows={5} value={editDescription} placeholder={t("Description")} aria-label={t("Description")} onChange={(e) => setEditDescription(e.target.value)} />
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-fg-subtle">{t("Due date")}</span>
              <input type="datetime-local" className={portal.ui.classes.inputSmall} value={editDue} aria-label={t("Due date")} onChange={(e) => setEditDue(e.target.value)} />
            </div>
            <button type="button" className={portal.ui.classes.primarySmall} disabled={busy} onClick={() => void saveCard()}>
              {t("Save")}
            </button>

            {otherStacks.length > 0 && (
              <div className="flex items-center gap-1">
                <portal.ui.Select
                  size="sm"
                  className="min-w-0 flex-1"
                  value={moveTo === null ? "" : String(moveTo)}
                  aria-label={t("Move this card to")}
                  onChange={(v) => setMoveTo(v === "" ? null : Number(v))}
                  options={([
                    { value: "", label: t("Move this card to…") },
                    ...otherStacks.map((s) => ({ value: String(s.id), label: s.title })),
                  ] as { value: string; label: string }[])}
                />
                <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || moveTo === null} onClick={() => moveTo !== null && moveCard(moveTo)}>
                  {t("Move")}
                </button>
              </div>
            )}
          </>
        )}
        {cardProblem !== null && <portal.ui.ErrorBanner onClose={() => setCardProblem(null)}>{cardProblem}</portal.ui.ErrorBanner>}
        {actionProblem !== null && <portal.ui.ErrorBanner onClose={() => setActionProblem(null)}>{actionProblem}</portal.ui.ErrorBanner>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {boards === null ? (
        boardProblem !== null ? (
          <portal.ui.ErrorBanner onClose={() => setBoardProblem(null)}>{t("The boards could not be read: {error}", { error: boardProblem })}</portal.ui.ErrorBanner>
        ) : (
          <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
        )
      ) : boards.length === 0 ? (
        <portal.ui.Empty>{t("No boards yet.")}</portal.ui.Empty>
      ) : (
        <>
          <div className="flex gap-1" role="group">
            {boards.map((board) => (
              <button key={board.id} type="button" aria-pressed={board.id === boardId} className={`nc-tab${board.id === boardId ? " nc-tab-on" : ""}`} onClick={() => chooseBoard(board.id)}>
                {board.color !== undefined && <span className="nc-dot" style={{ background: board.color }} />}
                <span>{board.title}</span>
              </button>
            ))}
          </div>

          {boardId !== null && (stacks === null ? (
            stackProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setStackProblem(null)}>{t("The stacks could not be read: {error}", { error: stackProblem })}</portal.ui.ErrorBanner>
            ) : (
              <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
            )
          ) : (
            <div className="space-y-2">
              {stacks.map((stack) => (
                <section key={stack.id}>
                  <header className="flex items-center gap-1 border-b pb-1 text-sm font-semibold" style={{ borderColor: "rgb(var(--line))" }}>
                    <span>{stack.title}</span>
                    <span className="text-xs font-normal text-fg-subtle">{stack.cards.length}</span>
                    <span className="flex-1" />
                    {newStackId === stack.id && (
                      <button type="button" className={portal.ui.classes.ghost} onClick={() => setNewStackId(null)} aria-label={t("Cancel the new card")}>
                        ×
                      </button>
                    )}
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => { setNewStackId(stack.id); setNewTitle(""); setNewDescription(""); setNewDue(""); }} aria-label={t("A new card in this stack")}>
                      <LuPlus /> {t("New card")}
                    </button>
                  </header>

                  {newStackId === stack.id && (
                    <form
                      className="space-y-1 p-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        createCard();
                      }}
                    >
                      <input className={portal.ui.classes.input} value={newTitle} placeholder={t("Card title")} aria-label={t("Card title")} onChange={(e) => setNewTitle(e.target.value)} />
                      <textarea className="nc-note-text" rows={2} value={newDescription} placeholder={t("Description")} aria-label={t("Description")} onChange={(e) => setNewDescription(e.target.value)} />
                      <div className="flex items-center gap-1">
                        <input type="datetime-local" className={portal.ui.classes.inputSmall} value={newDue} aria-label={t("Due date")} onChange={(e) => setNewDue(e.target.value)} />
                        <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newTitle.trim() === ""}>
                          {t("Add")}
                        </button>
                      </div>
                    </form>
                  )}

                  {stack.cards.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-fg-subtle">{t("No cards in this stack.")}</p>
                  ) : (
                    <ul className="space-y-0.5 p-0.5">
                      {stack.cards.map((c) => (
                        <li key={c.id}>
                          <button type="button" className={`nc-card${c.done ? " nc-card-done" : ""}`} onClick={() => openCard(stack.id, c)}>
                            <span className="min-w-0 flex-1 truncate text-left">{c.title}</span>
                            {c.duedate !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{showDate(c.duedate)}</span>}
                            {c.labels.slice(0, 3).map((label) => (
                              <span key={label.title} className="nc-chip shrink-0" style={label.color !== undefined ? { background: label.color, color: "#fff", borderColor: label.color } : undefined}>
                                {label.title}
                              </span>
                            ))}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          ))}
        </>
      )}
      {actionProblem !== null && <portal.ui.ErrorBanner onClose={() => setActionProblem(null)}>{actionProblem}</portal.ui.ErrorBanner>}
    </div>
  );
}
