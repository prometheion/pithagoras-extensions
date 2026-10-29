import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The Cookbook tab: the recipes by name and date, one chosen open to its ingredients and steps; a line to take a
 * recipe in from a page that carries schema.org. All of it as a tool call on the server. */

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
  const [chosen, setChosen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = () => {
    setRecipes(null);
    void api
      .tool("nc_cookbook_list_recipes", {}, instance)
      .then((result) => {
        const rows = (arrayOf(partText(result).data, "recipes") ?? []).map((r) => ({
          id: String(r.id),
          name: String(r.name ?? ""),
          imageUrl: typeof r.imageUrl === "string" ? r.imageUrl : undefined,
          dateCreated: typeof r.dateCreated === "string" ? r.dateCreated : undefined,
        }));
        setRecipes(rows);
      })
      .catch((error) => setProblem(sayError(error)));
  };

  useEffect(load, []);

  const open = (id: string) => {
    setChosen(id);
    setDetail(null);
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

  const ingredients = arrayOf(detail, "recipeIngredient");
  const steps = arrayOf(detail, "recipeInstructions") ?? (typeof detail?.recipeInstructions === "string" ? [{ value: detail.recipeInstructions }] : undefined);
  const textOf = (step: Record<string, unknown>): string => {
    if (typeof step.value === "string") return step.value;
    if (typeof step.text === "string") return step.text;
    if (typeof step.name === "string") return step.name;
    return JSON.stringify(step);
  };

  return (
    <div className="space-y-2">
      {recipes === null ? (
        problem ? (
          <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The recipes could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
        ) : (
          <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
        )
      ) : recipes.length === 0 ? (
        <portal.ui.Empty>{t("No recipes in that cookbook yet.")}</portal.ui.Empty>
      ) : chosen === null ? (
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
      ) : (
        <>
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setChosen(null)}>
            ← {t("All recipes")}
          </button>
          {detail === null ? (
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
