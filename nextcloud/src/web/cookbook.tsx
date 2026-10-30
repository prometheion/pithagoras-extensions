import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

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
  const [recipes, setRecipes] = useState<RecipeRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RecipeRow[] | null>(null); // what a searched word hit
  const [chosen, setChosen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // the one form the recipes go through: a made recipe fills it empty, an edited one with what stands there now
  const [formOpen, setFormOpen] = useState<null | "create" | "edit">(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formYield, setFormYield] = useState("");
  const [formIng, setFormIng] = useState(""); // one ingredient to a line
  const [formSteps, setFormSteps] = useState(""); // one step to a line

  const rowOf = (r: Record<string, unknown>): RecipeRow => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    imageUrl: typeof r.imageUrl === "string" ? r.imageUrl : undefined,
    dateCreated: typeof r.dateCreated === "string" ? r.dateCreated : undefined,
  });

  const load = () => {
    setRecipes(null);
    void api
      .tool("nc_cookbook_list_recipes", {}, instance)
      .then((result) => {
        const rows = (arrayOf(partText(result).data, "recipes") ?? []).map(rowOf);
        setRecipes(rows);
      })
      .catch((error) => setProblem(sayError(error)));
  };

  useEffect(load, []);

  const runSearch = () => {
    const word = query.trim();
    if (word === "") return;
    setSearchResults(null);
    void api
      .tool("nc_cookbook_search_recipes", { query: word }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? ((data as Record<string, unknown>).recipes ?? (data as Record<string, unknown>).results) : undefined;
        setSearchResults(Array.isArray(list) ? (list as Record<string, unknown>[]).map(rowOf) : []);
      })
      .catch((error) => setProblem(sayError(error)));
  };

  const open = (id: string) => {
    setChosen(id);
    setDetail(null);
    setFormOpen(null);
    void api
      .tool("nc_cookbook_get_recipe", { recipe_id: Number(id) }, instance)
      .then((result) => {
        const data = partText(result).data;
        if (typeof data === "object" && data !== null) setDetail(data as Record<string, unknown>);
        else setDetail({ name: id });
      })
      .catch((error) => setProblem(sayError(error)));
  };

  const importUrl = async () => {
    const target = url.trim();
    if (target === "" || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_cookbook_import_recipe", { url: target }, instance);
      setUrl("");
      load();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    setFormOpen("create");
    setFormName("");
    setFormDesc("");
    setFormYield("");
    setFormIng("");
    setFormSteps("");
  };

  /** The opened recipe's words into the form, lines by line where the server answers them joined. */
  const openEdit = () => {
    if (detail === null) return;
    setFormOpen("edit");
    setFormName(String(detail.name ?? ""));
    setFormDesc(typeof detail.description === "string" ? detail.description : "");
    setFormYield(typeof detail.recipe_yield === "string" ? detail.recipe_yield : typeof detail.recipeYield === "string" ? (detail.recipeYield as string) : "");
    const ings = arrayOf(detail, "recipeIngredient");
    setFormIng(ings ? ings.map((i) => String(typeof i === "object" && i !== null ? (i as Record<string, unknown>).value ?? "" : i)).filter((l) => l !== "").join("\n") : "");
    const steps = arrayOf(detail, "recipeInstructions") ?? (typeof detail.recipeInstructions === "string" ? [{ value: detail.recipeInstructions }] : undefined);
    setFormSteps(steps ? steps.map(textOf).filter((l) => l !== "").join("\n") : "");
  };

  const submitForm = async () => {
    if (busy || formOpen === null || formName.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      // one word to a line: the server's own words for what a recipe is made of and done by
      const lines = (word: string): string[] => word.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      const args: Record<string, unknown> = { name: formName.trim() };
      if (formDesc.trim() !== "") args.description = formDesc.trim();
      if (formYield.trim() !== "") args.recipe_yield = formYield.trim();
      const ings = lines(formIng);
      if (ings.length > 0) args.ingredients = ings;
      const steps = lines(formSteps);
      if (steps.length > 0) args.instructions = steps;
      if (formOpen === "create") {
        await api.tool("nc_cookbook_create_recipe", args, instance);
        setFormOpen(null);
        load();
      } else if (chosen !== null) {
        await api.tool("nc_cookbook_update_recipe", { ...args, recipe_id: Number(chosen) }, instance);
        setFormOpen(null);
        open(chosen); // its words as they stand now
      }
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || chosen === null || detail === null) return;
    if (!window.confirm(t("Take the recipe “{name}” away for good?", { name: String(detail.name ?? "") }))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_cookbook_delete_recipe", { recipe_id: Number(chosen) }, instance);
      setChosen(null);
      setDetail(null);
      load();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const ingredients = arrayOf(detail, "recipeIngredient");
  const steps = arrayOf(detail, "recipeInstructions") ?? (typeof detail?.recipeInstructions === "string" ? [{ value: detail.recipeInstructions }] : undefined);

  return (
    <div className="space-y-2">
      {recipes === null ? (
        problem ? (
          <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The recipes could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
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

          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => (formOpen === "create" ? setFormOpen(null) : openCreate())}>
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
              stepWords={formSteps} setStepWords={setFormSteps}
              submitLabel={t("Add")}
              onSubmit={() => void submitForm()}
              onCancel={() => setFormOpen(null)}
              busy={busy}
            />
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <button type="button" className={portal.ui.classes.ghost} onClick={() => { setChosen(null); setFormOpen(null); }}>
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
              stepWords={formSteps} setStepWords={setFormSteps}
              submitLabel={t("Save")}
              onSubmit={() => void submitForm()}
              onCancel={() => setFormOpen(null)}
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

      {problem && chosen !== null && recipes !== null && recipes.length > 0 && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("An error happened: {error}", { error: problem })}</portal.ui.ErrorBanner>
      )}
    </div>
  );
}

/** The recipe's words in a form: made empty, filled with what stands there when changed -- one line to an
 * ingredient or a step. */
function RecipeForm(props: {
  name: string; setName(w: string): void;
  desc: string; setDesc(w: string): void;
  yieldWord: string; setYieldWord(w: string): void;
  ings: string; setIngs(w: string): void;
  stepWords: string; setStepWords(w: string): void;
  submitLabel: string;
  onSubmit(): void;
  onCancel(): void;
  busy: boolean;
}) {
  const t2 = t;
  return (
    <form
      className="nc-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <input className={portal.ui.classes.input} value={props.name} placeholder={t2("The recipe's name")} aria-label={t2("The recipe's name")} onChange={(e) => props.setName(e.target.value)} />
      <textarea className="nc-note-text" rows={2} value={props.desc} placeholder={t2("What it is")} aria-label={t2("What it is")} style={{ minHeight: "0" }} onChange={(e) => props.setDesc(e.target.value)} />
      <input className={portal.ui.classes.inputSmall} value={props.yieldWord} placeholder={t2("For how many")} aria-label={t2("For how many")} onChange={(e) => props.setYieldWord(e.target.value)} />
      <textarea className="nc-note-text" rows={3} value={props.ings} placeholder={t2("The ingredients, one to a line")} aria-label={t2("The ingredients, one to a line")} style={{ minHeight: "0" }} onChange={(e) => props.setIngs(e.target.value)} />
      <textarea className="nc-note-text" rows={5} value={props.stepWords} placeholder={t2("The steps, one to a line")} aria-label={t2("The steps, one to a line")} style={{ minHeight: "0" }} onChange={(e) => props.setStepWords(e.target.value)} />
      <div className="flex gap-1">
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={props.busy || props.name.trim() === ""}>
          {props.submitLabel}
        </button>
        <button type="button" className={portal.ui.classes.ghost} onClick={props.onCancel}>
          {t2("Cancel")}
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
