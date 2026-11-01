import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";
import { confirmDelete } from "./widgets";

/** The Cookbook tab: the recipes by name and date, one chosen open to its ingredients and steps -- made new in
 * a form, reworded in it, taken away with a word; a line to take a recipe in from a page that carries schema.org,
 * and a word to search them by. All of it as a tool call on the server. */

interface RecipeRow {
  id: string;
  name: string;
  imageUrl?: string;
  dateCreated?: string;
}

export default function Cookbook() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the recipe calls go
  const guard = useGuard();
  const [recipes, setRecipes] = useState<RecipeRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RecipeRow[] | null>(null); // what a searched word hit
  const [chosen, setChosen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null); // a change or an opening that failed: drawn in whatever view stands
  const [loadError, setLoadError] = useState<string | null>(null); // the list that could not be read

  // the one form the recipes go through: a made recipe fills it empty, an edited one with what stands there now
  const [formOpen, setFormOpen] = useState<null | "create" | "edit">(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formYield, setFormYield] = useState("");
  const [formIng, setFormIng] = useState<string[]>([]); // every ingredient stands on its own entry
  const [formSteps, setFormSteps] = useState<string[]>([]); // every step stands on its own entry
  const [formStart, setFormStart] = useState(""); // the form's words as they were when it opened: what "changed" is measured against
  const formNow = JSON.stringify([formName, formDesc, formYield, formIng, formSteps]);
  const formDirty = formOpen !== null && formNow !== formStart;
  portal.ui.useUnsavedDraft(formDirty);

  const rowOf = (r: Record<string, unknown>): RecipeRow => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    imageUrl: typeof r.imageUrl === "string" ? r.imageUrl : undefined,
    dateCreated: typeof r.dateCreated === "string" ? r.dateCreated : undefined,
  });

  const load = (keep = false) => {
    const current = guard("list");
    if (!keep) setRecipes(null);
    setLoadError(null);
    void api
      .tool("nc_cookbook_list_recipes", {}, instance)
      .then((result) => {
        if (!current()) return;
        const rows = (arrayOf(partText(result).data, "recipes") ?? []).map(rowOf);
        setRecipes(rows);
      })
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = (word = query.trim()) => {
    if (word === "") return;
    const current = guard("search");
    setSearchResults(null);
    void api
      .tool("nc_cookbook_search_recipes", { query: word }, instance)
      .then((result) => {
        if (!current()) return;
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? ((data as Record<string, unknown>).recipes ?? (data as Record<string, unknown>).results) : undefined;
        setSearchResults(Array.isArray(list) ? (list as Record<string, unknown>[]).map(rowOf) : []);
      })
      .catch((error) => {
        if (!current()) return;
        setSearchResults([]);
        setProblem(sayError(error));
      });
  };

  /** After a recipe was made, changed or taken away: the list is read again, and a search that stands is run again. */
  const refreshLists = () => {
    load(true);
    if (searchResults !== null && query.trim() !== "") runSearch();
  };

  const open = (id: string) => {
    const current = guard("recipe");
    setChosen(id);
    setDetail(null);
    setFormOpen(null);
    setProblem(null);
    void api
      .tool("nc_cookbook_get_recipe", { recipe_id: Number(id) }, instance)
      .then((result) => {
        if (!current()) return;
        const data = partText(result).data;
        if (typeof data === "object" && data !== null) setDetail(data as Record<string, unknown>);
        else setDetail({ name: id });
      })
      .catch((error) => {
        if (!current()) return;
        setChosen(null); // back to the list, with the reason above it
        setProblem(sayError(error));
      });
  };

  const importUrl = async () => {
    const target = url.trim();
    if (target === "" || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_cookbook_import_recipe", { url: target }, instance);
      setUrl("");
      refreshLists();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  /** The form opened with these words in it; what it holds then is what a change is measured against. */
  const openForm = (kind: "create" | "edit", name: string, desc: string, yieldWord: string, ings: string[], steps: string[]) => {
    setFormOpen(kind);
    setFormName(name);
    setFormDesc(desc);
    setFormYield(yieldWord);
    setFormIng(ings);
    setFormSteps(steps);
    setFormStart(JSON.stringify([name, desc, yieldWord, ings, steps]));
  };

  const openCreate = () => openForm("create", "", "", "", [""], [""]); // one made row each, so the lists never start bare

  /** The opened recipe's words into the form, lines by line where the server answers them joined. */
  const openEdit = () => {
    if (detail === null) return;
    const ings = arrayOf(detail, "recipeIngredient");
    // instructions the server answers as one string are its lines: a step each
    const steps = arrayOf(detail, "recipeInstructions") ?? (typeof detail.recipeInstructions === "string" ? detail.recipeInstructions.split(/\r?\n+/).map((value) => ({ value })) : undefined);
    openForm(
      "edit",
      String(detail.name ?? ""),
      typeof detail.description === "string" ? detail.description : "",
      typeof detail.recipe_yield === "string" ? detail.recipe_yield : typeof detail.recipeYield === "string" ? (detail.recipeYield as string) : "",
      ings ? ings.map((i) => String(typeof i === "object" && i !== null ? (i as Record<string, unknown>).value ?? "" : i)).filter((l) => l !== "") : [],
      steps ? steps.map(textOf).filter((l) => l !== "") : [],
    );
  };

  const submitForm = async () => {
    if (busy || formOpen === null || formName.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      // every entry is one of the server's own words for what a recipe is made of and done by
      const words = (list: string[]): string[] => list.map((l) => l.trim()).filter((l) => l !== "");
      const args: Record<string, unknown> = { name: formName.trim() };
      const ings = words(formIng);
      const steps = words(formSteps);
      // A new recipe sends what it has. A changed one sends the fields too that it had and now has emptied: left
      // out, the server keeps the old words, and a description or a list could never be taken out again.
      const had = (key: string) => detail !== null && detail[key] !== undefined && detail[key] !== "" && !(Array.isArray(detail[key]) && (detail[key] as unknown[]).length === 0);
      if (formDesc.trim() !== "" || (formOpen === "edit" && had("description"))) args.description = formDesc.trim();
      if (formYield.trim() !== "" || (formOpen === "edit" && (had("recipe_yield") || had("recipeYield")))) args.recipe_yield = formYield.trim();
      if (ings.length > 0 || (formOpen === "edit" && had("recipeIngredient"))) args.ingredients = ings;
      if (steps.length > 0 || (formOpen === "edit" && had("recipeInstructions"))) args.instructions = steps;
      if (formOpen === "create") {
        await api.tool("nc_cookbook_create_recipe", args, instance);
        setFormOpen(null);
        refreshLists();
      } else if (chosen !== null) {
        await api.tool("nc_cookbook_update_recipe", { ...args, recipe_id: Number(chosen) }, instance);
        setFormOpen(null);
        open(chosen); // its words as they stand now
        refreshLists();
      }
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || chosen === null || detail === null) return;
    if (!(await confirmDelete(t("Take the recipe “{name}” away for good?", { name: String(detail.name ?? "") }), undefined, t("Delete this recipe")))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_cookbook_delete_recipe", { recipe_id: Number(chosen) }, instance);
      setChosen(null);
      setDetail(null);
      refreshLists();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const ingredients = arrayOf(detail, "recipeIngredient");
  const steps = arrayOf(detail, "recipeInstructions") ?? (typeof detail?.recipeInstructions === "string" ? [{ value: detail.recipeInstructions }] : undefined);

  /** Leaving the form with words in it asks first; true where it may go on. */
  const mayDropForm = async (): Promise<boolean> =>
    !formDirty || (await portal.ui.confirm({ title: t("Leave this recipe without saving?"), message: t("What you changed in it is lost."), confirmLabel: t("Leave"), danger: true }));

  return (
    <div className="space-y-2">
      {problem !== null && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
      {recipes === null ? (
        loadError ? (
          <portal.ui.LoadFailed error={t("The recipes could not be read: {error}", { error: loadError })} onRetry={() => load()} />
        ) : (
          <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
        )
      ) : chosen === null ? (
        <>
          <div className="flex gap-1">
            <input
              className={portal.ui.classes.input}
              value={query}
              placeholder={t("Search the recipes")}
              aria-label={t("Search the recipes")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } }}
            />
            <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || query.trim() === ""} onClick={() => void runSearch()}>
              {t("Search")}
            </button>
            {(query !== "" || searchResults !== null) && (
              <button type="button" className={portal.ui.classes.ghost} onClick={() => { setQuery(""); setSearchResults(null); }}>
                ×
              </button>
            )}
          </div>

          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => (formOpen === "create" ? void mayDropForm().then((ok) => ok && setFormOpen(null)) : openCreate())}>
            {formOpen === "create" ? "−" : "+"} {t("A new recipe")}
          </button>

          {searchResults === null ? (
            recipes.length === 0 ? (
              <portal.ui.Empty>{t("No recipes in that cookbook yet.")}</portal.ui.Empty>
            ) : (
              <ul className="space-y-1">
                {recipes.map((recipe) => (
                  <li key={recipe.id}>
                    <button type="button" className="nc-open" onClick={() => open(recipe.id)}>
                      {recipe.imageUrl && recipe.imageUrl !== "" && <img className="nc-thumb" src={recipe.imageUrl} alt="" />}
                      <span className="nc-open-title">{recipe.name}</span>
                      {recipe.dateCreated && <span className="nc-open-date">{recipe.dateCreated.slice(0, 10)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : searchResults.length === 0 ? (
            <portal.ui.Empty>{t("Nothing found for “{query}”.", { query })}</portal.ui.Empty>
          ) : (
            <ul className="space-y-1">
              {searchResults.map((recipe) => (
                <li key={recipe.id}>
                  <button type="button" className="nc-open" onClick={() => open(recipe.id)}>
                    {recipe.imageUrl && recipe.imageUrl !== "" && <img className="nc-thumb" src={recipe.imageUrl} alt="" />}
                    <span className="nc-open-title">{recipe.name}</span>
                    {recipe.dateCreated && <span className="nc-open-date">{recipe.dateCreated.slice(0, 10)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {formOpen === "create" && (
            <RecipeForm
              name={formName} setName={setFormName}
              desc={formDesc} setDesc={setFormDesc}
              yieldWord={formYield} setYieldWord={setFormYield}
              ings={formIng} setIngs={setFormIng}
              steps={formSteps} setSteps={setFormSteps}
              submitLabel={t("Add")}
              onSubmit={() => void submitForm()}
              onCancel={() => void mayDropForm().then((ok) => ok && setFormOpen(null))}
              busy={busy}
            />
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <button type="button" className={portal.ui.classes.ghost} onClick={() => void mayDropForm().then((ok) => { if (ok) { setChosen(null); setFormOpen(null); setProblem(null); } })}>
              ← {t("All recipes")}
            </button>
            <span className="flex-1" />
            {detail !== null && formOpen !== "edit" && (
              <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void openEdit()}>
                ✎ {t("Change this recipe")}
              </button>
            )}
            {detail !== null && (
              <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void remove()}>
                {t("Delete this recipe")}
              </button>
            )}
          </div>

          {formOpen === "edit" ? (
            <RecipeForm
              name={formName} setName={setFormName}
              desc={formDesc} setDesc={setFormDesc}
              yieldWord={formYield} setYieldWord={setFormYield}
              ings={formIng} setIngs={setFormIng}
              steps={formSteps} setSteps={setFormSteps}
              submitLabel={t("Save")}
              onSubmit={() => void submitForm()}
              onCancel={() => void mayDropForm().then((ok) => ok && setFormOpen(null))}
              busy={busy}
            />
          ) : detail === null ? (
            <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
          ) : (
            <div className="space-y-2">
              <h3 className="nc-detail-title">{String(detail.name ?? "")}</h3>
              {typeof detail.description === "string" && detail.description !== "" && <p className="text-xs text-fg-muted">{detail.description}</p>}
              {ingredients ? (
                <>
                  <h4 className="nc-detail-heading">{t("Ingredients")}</h4>
                  <ul className="list-disc pl-4 text-sm">
                    {ingredients.map((ing, i) => (
                      <li key={i}>{String(ing.value ?? ing)}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {steps ? (
                <>
                  <h4 className="nc-detail-heading">{t("Steps")}</h4>
                  <ol className="list-decimal pl-4 text-sm">
                    {steps.map((step, i) => (
                      <li key={i}>{textOf(step)}</li>
                    ))}
                  </ol>
                </>
              ) : null}
            </div>
          )}
        </>
      )}

      {/* The import line stands below the view in one fixed place -- even while it loads, so nothing flashes in. */}
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void importUrl();
        }}
      >
        <input
          className={portal.ui.classes.input}
          value={url}
          placeholder={t("Import a recipe from its URL")}
          aria-label={t("Import a recipe from its URL")}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || url.trim() === ""}>
          {t("Import")}
        </button>
      </form>
    </div>
  );
}

/** The recipe's words in a form: made empty, filled with what stands there when changed -- every ingredient
 * and every step is an entry of its own list, so nothing has to be split by hand. */
function RecipeForm(props: {
  name: string; setName(w: string): void;
  desc: string; setDesc(w: string): void;
  yieldWord: string; setYieldWord(w: string): void;
  ings: string[]; setIngs(w: string[]): void;
  steps: string[]; setSteps(w: string[]): void;
  submitLabel: string;
  onSubmit(): void;
  onCancel(): void;
  busy: boolean;
}) {
  /** One list of the form: a spoken name above, an entry per row with its way out, and the door for one more. */
  const listOf = (label: string, words: string[], setWords: (w: string[]) => void, addWord: string) => (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-fg-muted">{label}</span>
      {words.map((word, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            className={portal.ui.classes.input}
            value={word}
            aria-label={`${label} ${i + 1}`}
            onChange={(e) => {
              const next = words.slice();
              next[i] = e.target.value;
              setWords(next);
            }}
          />
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setWords(words.filter((_, j) => j !== i))} aria-label={t("Take this one away")}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className={portal.ui.classes.ghost} onClick={() => setWords([...words, ""])}>
        + {addWord}
      </button>
    </div>
  );
  return (
    <form
      className="nc-form"
      style={{ gap: "0.9rem" }}
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="space-y-1">
        <span className="block text-xs font-medium text-fg-muted">{t("The recipe's name")}</span>
        <input className={portal.ui.classes.input} value={props.name} aria-label={t("The recipe's name")} onChange={(e) => props.setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <span className="block text-xs font-medium text-fg-muted">{t("What it is")}</span>
        <textarea className="nc-note-text" rows={2} value={props.desc} aria-label={t("What it is")} style={{ minHeight: "0" }} onChange={(e) => props.setDesc(e.target.value)} />
      </div>
      <div className="space-y-1">
        <span className="block text-xs font-medium text-fg-muted">{t("For how many")}</span>
        <input className={portal.ui.classes.inputSmall} value={props.yieldWord} aria-label={t("For how many")} onChange={(e) => props.setYieldWord(e.target.value)} />
      </div>
      {listOf(t("Ingredients"), props.ings, props.setIngs, t("one more ingredient"))}
      {listOf(t("Steps"), props.steps, props.setSteps, t("one more step"))}
      <div className="flex gap-1">
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={props.busy || props.name.trim() === ""}>
          {props.submitLabel}
        </button>
        <button type="button" className={portal.ui.classes.ghost} onClick={props.onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

/** One step's words, however the server answers them: as its own line or as a piece of it. */
function textOf(step: Record<string, unknown>): string {
  if (typeof step.value === "string") return step.value;
  if (typeof step.text === "string") return step.text;
  if (typeof step.name === "string") return step.name;
  return JSON.stringify(step);
}
