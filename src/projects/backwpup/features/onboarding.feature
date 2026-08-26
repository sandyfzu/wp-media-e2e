@plugin
Feature: BackWPup onboarding

  A freshly installed BackWPup puts the site inside a three-step onboarding process — what to back
  up, when, and where — and nothing else in the plugin is reachable until it is finished.
  Completing it creates the scheduled job (or jobs) the site will run from then on, and starts a
  first backup immediately.

  Whether onboarding produces one job or two is the plugin's own rule and the reason several
  scenarios below look alike: files and the database share a job only when they are scheduled
  identically. Outcomes are asserted twice wherever both sources can answer — once against what the
  user sees, once against the job configuration WP-CLI reports — so a screen that renders the right
  thing over the wrong state cannot pass.

  The Background is itself coverage: asking for the dashboard on a fresh install and being sent to
  the onboarding page instead is the rule that makes onboarding unskippable, so every scenario
  re-proves it.

  Background:
    Given a freshly installed BackWPup
    When I open the BackWPup dashboard
    Then I land on the onboarding page instead

  # ── What gets backed up ──────────────────────────────────────────────────────

  Scenario: Files and the database are backed up together by one job
    Then every file area is included in the backup
    And every table of this WordPress install is included in the backup
    When I continue to the schedule step
    And I continue to the storage step
    And I store backups on the website server
    And I complete onboarding
    Then the first backup completes
    And the site has 1 stored backup
    And the scheduled backup jobs are:
      | contents           | storage        |
      | files and database | website server |
    When I open the BackWPup dashboard
    Then the dashboard shows 1 "mixed" backup job card
    And the dashboard shows 1 backup job card in total

  Scenario: Only the files are backed up
    When I exclude "database" from the backup
    Then "files" is included in the backup
    And "database" is not included in the backup
    When I continue to the schedule step
    And I continue to the storage step
    And I store backups on the website server
    And I complete onboarding
    Then the first backup completes
    And the scheduled backup jobs are:
      | contents | storage        |
      | files    | website server |
    When I open the BackWPup dashboard
    Then the dashboard shows 1 "files" backup job card
    And the dashboard shows 1 backup job card in total

  Scenario: Only the database is backed up
    When I exclude "files" from the backup
    Then "database" is included in the backup
    And "files" is not included in the backup
    When I continue to the schedule step
    And I continue to the storage step
    And I store backups on the website server
    And I complete onboarding
    Then the first backup completes
    And the scheduled backup jobs are:
      | contents | storage        |
      | database | website server |
    When I open the BackWPup dashboard
    Then the dashboard shows 1 "database" backup job card
    And the dashboard shows 1 backup job card in total

  Scenario: There has to be something to back up
    When I exclude "files" from the backup
    And I exclude "database" from the backup
    Then onboarding will not leave the data step
    When I include "files" in the backup
    Then onboarding will leave the data step

  # ── When it runs ─────────────────────────────────────────────────────────────

  Scenario: Backing files and the database up at different times splits them into two jobs
    When I continue to the schedule step
    And I schedule the "files" backup "weekly"
    And I schedule the "database" backup "daily"
    And I continue to the storage step
    And I store backups on the website server
    And I complete onboarding
    Then the first backup completes
    And the scheduled backup jobs are:
      | contents | storage        |
      | files    | website server |
      | database | website server |
    And the "files" backup job runs "weekly"
    And the "database" backup job runs "daily"
    When I open the BackWPup dashboard
    Then the dashboard shows 1 "files" backup job card
    And the dashboard shows 1 "database" backup job card
    And the dashboard shows 2 backup job cards in total

  Scenario: Scheduling files and the database differently in the advanced settings splits them into two jobs
    When I continue to the schedule step
    And I schedule the "files" backup "daily" through the advanced settings
    And I schedule the "database" backup "weekly" through the advanced settings
    And I continue to the storage step
    And I store backups on the website server
    And I complete onboarding
    Then the first backup completes
    And the scheduled backup jobs are:
      | contents | storage        |
      | files    | website server |
      | database | website server |
    And the "files" backup job runs "daily"
    And the "database" backup job runs "weekly"
    And the two backup jobs run on different schedules
    When I open the BackWPup dashboard
    Then the dashboard shows 1 "files" backup job card
    And the dashboard shows 1 "database" backup job card
    And the dashboard shows 2 backup job cards in total

  Scenario: Stepping back through onboarding keeps the choices already made
    When I exclude "database" from the backup
    And I continue to the schedule step
    And I schedule the "files" backup "weekly"
    And I continue to the storage step
    And I go back to the schedule step
    Then the onboarding page still has the "files" backup set to "weekly"
    When I go back to the data step
    Then "files" is included in the backup
    And "database" is not included in the backup

  # ── Where it goes ────────────────────────────────────────────────────────────

  Scenario: Onboarding cannot be finished without somewhere to store the backup
    When I continue to the schedule step
    And I continue to the storage step
    Then onboarding cannot be completed yet
    When I store backups on the website server
    Then onboarding can be completed

  # ── What the choices are worth ───────────────────────────────────────────────

  # Asserted against the stored job only. Re-reading the choices from the job card's own panels
  # would need the dashboard's own controls, and those are not reliably clickable on this screen
  # yet — so that half belongs with the dashboard's own coverage rather than here.
  Scenario: The data selection made during onboarding survives it
    When I exclude the "plugins" file area from the backup
    And I exclude the "options" database table from the backup
    And I continue to the schedule step
    And I continue to the storage step
    And I store backups on the website server
    And I complete onboarding
    Then the first backup completes
    And the scheduled backup job excludes the "plugins" file area
    And the scheduled backup job excludes the "options" database table
