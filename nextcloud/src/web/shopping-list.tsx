import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The Shopping List tab: the lists, one chosen by name; its items checked (tick), added by their name and taken
 * away one by one or in the checked ones at once. All of it as a tool call on the server, answered into these views. */

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
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [listId, setListId] = useState<number | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [newItem, setNewItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void api
      .tool("nc_shopping_list_get_lists", {}, instance)
      .then((result) => {
        if (gone) return;
        const rows = (arrayOf(partText(result).data, "lists") ?? []).map((l) => ({ id: Number(l.id), title: String(l.title ?? "") }));
        setLists(rows);
        setListId(rows.length > 0 ? rows[0].id : null);
      })
      .catch((error) => !gone && setProblem(sayError(error)));
    return () => {
      gone = true;
    };
  }, []);

  const loadItems = (id: number) => {
    setItems(null);
    void api
      .tool("nc_shopping_list_get_items", { list_id: id }, instance)
      .then((result) => {
        const rows = (arrayOf(partText(result).data, "items") ?? []).map((i) => ({
          id: Number(i.id),
          listId: Number(i.listId ?? i.list_id),
          name: String(i.name ?? ""),
          quantity: typeof i.quantity === "string" ? i.quantity : null,
          unit: typeof i.unit === "string" ? i.unit : null,
          checked: Boolean(i.checked),
        }));
        setItems(rows);
      })
      .catch((error) => setProblem(sayError(error)));
  };

  const choose = (id: number) => {
    setListId(id);
    loadItems(id);
  };

  const act = async (fn: () => Promise<unknown>, then?: () => void) => {
    if (busy || listId === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      loadItems(listId);
      then?.();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const tick = (item: ItemRow, checked: boolean) => act(() => api.tool("nc_shopping_list_check_item", { list_id: listId, item_id: item.id, checked }, instance));
  const add = () => {
    const name = newItem.trim();
    if (name === "") return;
    setNewItem("");
    void act(() => api.tool("nc_shopping_list_add_items", { list_id: listId, items: [{ name }] }, instance));
  };
  const remove = (item: ItemRow) => void act(() => api.tool("nc_shopping_list_delete_item", { list_id: listId, item_id: item.id }, instance));
  const clearChecked = () => void act(() => api.tool("nc_shopping_list_clear_checked_items", { list_id: listId }, instance));

  if (lists === null)
    return problem ? (
      <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The lists could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
    ) : (
      <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
    );

  const checkedCount = (items ?? []).filter((i) => i.checked).length;
  return (
    <div className="space-y-2">
      {lists.length === 0 ? (
        <portal.ui.Empty>{t("No shopping lists on that Nextcloud.")}</portal.ui.Empty>
      ) : (
        <>
          <div className="flex gap-1" role="group">
            {lists.map((l) => (
              <button key={l.id} type="button" aria-pressed={l.id === listId} className={`nc-tab${l.id === listId ? " nc-tab-on" : ""}`} onClick={() => choose(l.id)}>
                <span>{l.title}</span>
              </button>
            ))}
          </div>

          {listId !== null && (
            <>
              {items === null ? (
                <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
              ) : items.length === 0 ? (
                <p className="px-1 text-xs text-fg-subtle">{t("Nothing on this list.")}</p>
              ) : (
                <ul className="space-y-1">
                  {items.map((item) => (
                    <li key={item.id} className={`nc-item${item.checked ? " nc-item-done" : ""}`}>
                      <label className="nc-item-check">
                        <input type="checkbox" checked={item.checked} disabled={busy} onChange={() => tick(item, !item.checked)} />
                        <span>{item.quantity && item.quantity !== "1" ? `${item.quantity} ` : ""}{item.name}</span>
                        {item.unit && <span className="nc-item-unit"> {item.unit}</span>}
                      </label>
                      <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => remove(item)} aria-label={t("Remove this item")}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <input className={portal.ui.classes.input} value={newItem} placeholder={t("Add an item")} aria-label={t("Add an item")} onChange={(e) => setNewItem(e.target.value)} />
                <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newItem.trim() === ""}>
                  {t("Add")}
                </button>
              </form>

              {checkedCount > 0 && (
                <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={clearChecked}>
                  {t("{n} checked: remove them", { n: checkedCount })}
                </button>
              )}
            </>
          )}
        </>
      )}
      {problem && lists.length > 0 && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("An error happened: {error}", { error: problem })}</portal.ui.ErrorBanner>}
    </div>
  );
}
