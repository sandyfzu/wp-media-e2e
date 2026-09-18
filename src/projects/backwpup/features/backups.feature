@plugin
Feature: BackWPup backups and their history

  Once a site is set up, BackWPup makes backups two ways — the user presses "Backup Now", or the
  schedule comes due — and keeps every archive in a history table from which they can be downloaded
  and deleted. These scenarios cover that whole life, from making a backup to removing it.

  The setup is done through WP-CLI rather than by driving onboarding again: onboarding is its own
  feature, and finishing it starts a full backup of the site that nothing here would learn anything
  from. The state it produces was compared against a real onboarding field by field.

  Every count is asserted twice, from independent sources: the rows the table renders, and the
  archives BackWPup itself reports. A table showing a row for an archive that is gone, or hiding one
  that is not, is precisely the failure a DOM-only assertion cannot see. The database is what these
  jobs back up — the smallest real backup a site can make, which keeps the scenarios honest about
  running a genuine job without writing gigabytes per scenario.

  Background:
    Given BackWPup is set up to back up the "database" on a schedule

  # ── Making a backup ──────────────────────────────────────────────────────────

  Scenario: Backing up on demand from the dashboard adds one archive to the history
    When I open the BackWPup dashboard
    And I back up now
    Then the backup history shows 1 backup
    And no backup in the history has failed

  Scenario: A backup runs on its own once its schedule comes due
    Then the backup job is scheduled to run
    When its schedule comes due
    Then the newest backup was made by the scheduled job
    When I open the BackWPup dashboard
    Then the backup history shows 1 backup
    And no backup in the history has failed

  # ── Using a stored backup ────────────────────────────────────────────────────

  # Two archives, not one, in both scenarios below: with a single row "the newest" cannot pick the
  # wrong one, so neither scenario could fail for the reason its name gives.
  # "That exact archive" is asserted byte for byte: the file's digest is compared against one the
  # site computes for the archive it still holds, so a body corrupted in transit fails even when its
  # name and length are right.
  Scenario: Downloading a backup from the history saves that exact archive
    Given the site has already made 2 backups
    When I open the BackWPup dashboard
    And I download the newest backup
    Then the downloaded file is the newest stored archive

  Scenario: Deleting a backup from the history removes it from the site
    Given the site has already made 2 backups
    When I open the BackWPup dashboard
    Then the backup history shows 2 backups
    When I delete the newest backup
    Then the backup history shows 1 backup

  Scenario: Bulk-deleting the selected backups removes every one of them
    Given the site has already made 2 backups
    When I open the BackWPup dashboard
    Then the backup history shows 2 backups
    When I select every backup in the history
    And I delete the selected backups
    Then the backup history shows 0 backups
