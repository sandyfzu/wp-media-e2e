# Driven by `reporting/page-loads.run.spec.ts` on a placeholder site, through the real `bddgen`,
# runner and shared fixtures — never collected by a product, whose features live under `src/projects/`.
# The site's pages are served by `page.route`, so nothing leaves the machine.
Feature: The site's own lost requests, reported on failure

  @noauth
  Scenario: A page that lost its own script fails, and the report lists the script
    Given the site's dashboard loads without its own script
    Then the dashboard shows what its script renders

  @noauth
  Scenario: A passing scenario whose page lost a script reports nothing
    Given the site's dashboard loads without its own script
