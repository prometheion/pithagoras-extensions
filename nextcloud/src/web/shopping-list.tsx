import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";
import { confirmDelete } from "./widgets";

/** The Shopping List tab: the lists -- made, renamed and taken away by name; its items checked (tick), added
 * with their name and measure, edited one by one, and taken away singly, in the checked ones at once, or all
 * unchecked at once. All of it as a tool call on the server, answered into these views. */

interface ListRow {
  id: number;
  title: string;
}
interface ItemRow {
  id: number;
  listId?: number;
  name: string;
  quantity?: string | null;
  unit?: string | null;
  checked: boolean;
}

export default function ShoppingList() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the list calls go
  const guard = useGuard();
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [listId, setListId] = useState<number | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // the add-item form and the one item open to editing: their words as they stand
  const [newItem, setNewItem] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editQty, setEditQty] = useState("");
  const [editUnit, setEditUnit] = useState("");

  // the list's own words: "new" makes a list, "rename" rewords the chosen one
  const [manage, setManage] = useState<null | "new" | "rename">(null);
  const [listTitle, setListTitle] = useState("");

  const toLists = (result: Awaited<ReturnType<typeof api.tool>>): ListRow[] =>
    (arrayOf(partText(result).data, "lists") ?? []).map((l) => ({ id: Number(l.id), title: String(l.title ?? "") }));

  /** The lists, read again; `pick` says which stands chosen after (the one that stood, where it still does). */
  const loadLists = async (pick?: (rows: ListRow[]) => number | null) => {
    const current = guard("lists");
    setLoadError(null);
    try {
      const rows = toLists(await api.tool("nc_shopping_list_get_lists", {}, instance));
      if (!current()) return;
      setLists(rows);
      setListId((now) => (pick ? pick(rows) : rows.some((r) => r.id === now) ? now : (rows[0]?.id ?? null)));
    } catch (error) {
      if (current()) setLoadError(sayError(error));
    }
  };

  useEffect(() => {
    void loadLists();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The items of the chosen list, whenever the choice changes -- the first list that opens included. The ones on
   * screen stay while the new ones come, so a tick or an add does not blank the list. */
  const loadItems = async (id: number, keep = false) => {
    const current = guard("items");
    if (!keep) setItems(null);
    try {
      const result = await api.tool("nc_shopping_list_get_items", { list_id: id }, instance);
      if (!current()) return;
      setItems(
        (arrayOf(partText(result).data, "items") ?? []).map((i) => ({
          id: Number(i.id),
          listId: Number(i.listId ?? i.list_id),
          name: String(i.name ?? ""),
          quantity: typeof i.quantity === "string" ? i.quantity : null,
          unit: typeof i.unit === "string" ? i.unit : null,
          checked: Boolean(i.checked),
        })),
      );
    } catch (error) {
      if (current()) {
        setItems([]);
        setProblem(t("The items could not be read: {error}", { error: sayError(error) }));
      }
    }
  };

  useEffect(() => {
    setEditingId(null);
    if (listId !== null) void loadItems(listId);
    else setItems([]);
  }, [listId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One change, then the items again (on screen meanwhile); the typed words are cleared only once it worked. */
  const act = async (fn: () => Promise<unknown>, then?: () => void): Promise<boolean> => {
    if (busy || listId === null) return false;
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      then?.();
      await loadItems(listId, true);
      return true;
    } catch (error) {
      setProblem(sayError(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const tick = (item: ItemRow, checked: boolean) => act(() => api.tool("nc_shopping_list_check_item", { list_id: listId, item_id: item.id, checked }, instance));

  /** The server reads only the words given: an empty measure is gone for good, not a zero. */
  const add = () => {
    const name = newItem.trim();
    if (name === "") return;
    const item: Record<string, unknown> = { name };
    if (newQty.trim() !== "") item.quantity = newQty.trim();
    if (newUnit.trim() !== "") item.unit = newUnit.trim();
    void act(() => api.tool("nc_shopping_list_add_items", { list_id: listId, items: [item] }, instance), () => {
      setNewItem("");
      setNewQty("");
      setNewUnit("");
    });
  };

  const openEdit = (item: ItemRow) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditQty(item.quantity ?? "");
    setEditUnit(item.unit ?? "");
  };

  const saveEdit = () => {
    if (listId === null || editingId === null) return;
    const name = editName.trim();
    void act(() => api.tool("nc_shopping_list_update_item", { list_id: listId, item_id: editingId, name: name !== "" ? name : undefined, quantity: editQty.trim() !== "" ? editQty.trim() : null, unit: editUnit.trim() !== "" ? editUnit.trim() : null }, instance), () => setEditingId(null));
  };

  const remove = (item: ItemRow) => void act(() => api.tool("nc_shopping_list_delete_item", { list_id: listId, item_id: item.id }, instance));
  const clearChecked = () => void act(() => api.tool("nc_shopping_list_clear_checked_items", { list_id: listId }, instance));
  const uncheckAll = () => void act(() => api.tool("nc_shopping_list_uncheck_all_items", { list_id: listId }, instance));

  // the list's own words, answered against what the server says after
  const createList = async () => {
    const title = listTitle.trim();
    if (title === "" || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_shopping_list_create_list", { title }, instance);
      setManage(null);
      setListTitle("");
      // the made list's id: the server's answer apart, it is the newest of what is listed now
      await loadLists((rows) => rows.filter((r) => r.title === title).sort((a, b) => b.id - a.id)[0]?.id ?? rows[0]?.id ?? null);
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const renameList = async () => {
    const title = listTitle.trim();
    if (title === "" || busy || listId === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_shopping_list_update_list", { list_id: listId, title }, instance);
      setManage(null);
      await loadLists((rows) => (rows.some((r) => r.id === listId) ? listId : (rows[0]?.id ?? null)));
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteList = async () => {
    if (busy || listId === null) return;
    const chosen = lists?.find((l) => l.id === listId);
    if (!(await confirmDelete(t("Take the list “{title}” away for good?", { title: chosen?.title ?? "" }), undefined, t("Delete this list")))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_shopping_list_delete_list", { list_id: listId }, instance);
      setManage(null);
      await loadLists((rows) => rows[0]?.id ?? null);
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  if (lists === null)
    return loadError ? <portal.ui.LoadFailed error={t("The lists could not be read: {error}", { error: loadError })} onRetry={() => void loadLists()} /> : <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const checkedCount = (items ?? []).filter((i) => i.checked).length;
  const newList = () => {
    setManage("new");
    setListTitle("");
  };

  const newListForm = (
    <form
      className="flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void createList();
      }}
    >
      <input className={portal.ui.classes.input} value={listTitle} placeholder={t("What the list is called")} aria-label={t("What the list is called")} onChange={(e) => setListTitle(e.target.value)} />
      <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || listTitle.trim() === ""}>
        {t("Add")}
      </button>
      <button type="button" className={portal.ui.classes.ghost} onClick={() => setManage(null)}>
        {t("Cancel")}
      </button>
    </form>
  );

  return (
    <div className="space-y-2">
      {problem && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
      {loadError && <portal.ui.LoadFailed error={t("The lists could not be read: {error}", { error: loadError })} onRetry={() => void loadLists()} />}
      {manage === "new" ? (
        newListForm
      ) : lists.length === 0 ? (
        <div className="space-y-1">
          <portal.ui.Empty>{t("No shopping lists on that Nextcloud.")}</portal.ui.Empty>
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} aria-label={t("A new list")} onClick={newList}>
            + {t("New list")}
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <portal.ui.Segments
              label={t("Shopping lists")}
              value={String(listId ?? "")}
              options={lists.map((l) => ({ id: String(l.id), label: l.title }))}
              onChange={(id) => {
                if (busy) return;
                setManage(null);
                setListId(Number(id));
              }}
            />
            <button type="button" className={portal.ui.classes.ghost} disabled={busy} aria-label={t("A new list")} onClick={newList}>
              + {t("New list")}
            </button>
          </div>

          {listId !== null && (
              <>
                {items === null ? (
                  <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
                ) : items.length > 0 && (
                  <ul className="space-y-1">
                    {items.map((item) =>
                      editingId === item.id ? (
                        <li key={item.id} className="nc-item space-y-1">
                          <input className="nc-note-title" value={editName} aria-label={t("The item's name")} onChange={(e) => setEditName(e.target.value)} />
                          <div className="flex gap-1">
                            <input className={portal.ui.classes.inputSmall} value={editQty} placeholder={t("How much")} aria-label={t("How much")} onChange={(e) => setEditQty(e.target.value)} />
                            <input className={portal.ui.classes.inputSmall} value={editUnit} placeholder={t("In what")} aria-label={t("In what")} onChange={(e) => setEditUnit(e.target.value)} />
                          </div>
                          <div className="flex gap-1">
                            <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || editName.trim() === ""} onClick={() => void saveEdit()}>
                              {t("Save")}
                            </button>
                            <button type="button" className={portal.ui.classes.ghost} onClick={() => setEditingId(null)}>
                              {t("Cancel")}
                            </button>
                          </div>
                        </li>
                      ) : (
                        <li key={item.id} className={`nc-item${item.checked ? " nc-item-done" : ""}`}>
                          <label className="nc-item-check">
                            <input type="checkbox" checked={item.checked} disabled={busy} onChange={() => tick(item, !item.checked)} />
                            <span className="nc-item-name">{item.quantity && item.quantity !== "1" ? `${item.quantity} ` : ""}{item.name}</span>
                            {item.unit && <span className="nc-item-unit"> {item.unit}</span>}
                          </label>
                          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => openEdit(item)} aria-label={t("Change this item")}>
                            ✎
                          </button>
                          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => remove(item)} aria-label={t("Remove this item")}>
                            ×
                          </button>
                        </li>
                      )
                    )}
                  </ul>
                )}

                {/* The add form stands below the list even while it loads: a fixed place, nothing to flash in. */}
                <form
                  className="nc-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    add();
                  }}
                >
                  <p className="nc-form-title">{t("A new item")}</p>
                  <div className="flex flex-wrap gap-1">
                    <input className={portal.ui.classes.input} value={newItem} placeholder={t("Add an item")} aria-label={t("Add an item")} onChange={(e) => setNewItem(e.target.value)} />
                    <input type="number" min="0" step="any" className={portal.ui.classes.inputSmall} value={newQty} placeholder={t("How much")} aria-label={t("How much")} onChange={(e) => setNewQty(e.target.value)} />
                    <input className={portal.ui.classes.inputSmall} value={newUnit} placeholder={t("In what")} aria-label={t("In what")} onChange={(e) => setNewUnit(e.target.value)} />
                  </div>
                  <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newItem.trim() === ""}>
                    {t("Add")}
                  </button>
                </form>

                {checkedCount > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={clearChecked}>
                      {t("{n} checked: remove them", { n: checkedCount })}
                    </button>
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={uncheckAll}>
                      {t("Uncheck them all")}
                    </button>
                  </div>
                )}

                {manage === "rename" ? (
                  <form
                    className="flex gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void renameList();
                    }}
                  >
                    <input className={portal.ui.classes.input} value={listTitle} aria-label={t("What the list is called")} onChange={(e) => setListTitle(e.target.value)} />
                    <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || listTitle.trim() === ""}>
                      {t("Save")}
                    </button>
                    <button type="button" className={portal.ui.classes.ghost} onClick={() => setManage(null)}>
                      {t("Cancel")}
                    </button>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={portal.ui.classes.ghost}
                      disabled={busy}
                      onClick={() => {
                        setManage("rename");
                        const chosen = lists.find((l) => l.id === listId);
                        setListTitle(chosen?.title ?? "");
                      }}
                    >
                      ✎ {t("Rename this list")}
                    </button>
                    <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void deleteList()}>
                      {t("Delete this list")}
                    </button>
                  </div>
                )}
              </>
          )}
        </>
      )}
    </div>
  );
}
