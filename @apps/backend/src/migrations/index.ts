import { Migration20261026083909_initial } from "./Migration20261026083909_initial.js";

// Liste explicite, comme seedersList : la découverte par glob de MikroORM échoue
// sous vite-node (`MigrationClass is not a constructor`). Toute migration créée
// par `migration:create` doit être ajoutée ici, ce que vérifie migrations.test.ts.
export const migrationsList = [
  { name: "Migration20261026083909_initial", class: Migration20261026083909_initial },
];
