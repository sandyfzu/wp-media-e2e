@pro @plugin @slow
Feature: Restoring a BackWPup backup over WP-CLI

  `wp backwpup restore` puts back what `--type` names: the database (`db`), the content directory
  (`file`) or both (`full`, the default). Each scenario plants one known value in the site's files and
  one in its database, backs the site up, changes both values, and restores; the half the command was
  to restore must hold the backed-up value again, the other half the changed one. The command's own
  word is not enough: it reports success after a rollback too.

  A files restore replaces the content directory wholesale, deleting whatever the archive does not
  hold, and a database restore drops and recreates the database. So the suite copies the content
  directory before such a command and puts it back afterwards, and sets the database's default
  collation back — the site ends as it was found.

  Background:
    Given the site holds marker data in its files and in its database
    And BackWPup is set up to back up the "files and database" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup

  Scenario: A full restore over WP-CLI brings the site's files and database back
    When I run the BackWPup restore command "restore {path to the newest backup} --yes --type=full"
    Then the command succeeds
    And it reports the success "Restore completed successfully."
    And the site's files are back as they were in the backup
    And the site's database is back as it was in the backup

  Scenario: A database restore over WP-CLI brings the database back and leaves the files changed
    When I run the BackWPup restore command "restore {path to the newest backup} --yes --type=db"
    Then the command succeeds
    And it reports the success "Restore completed successfully."
    And the site's database is back as it was in the backup
    And the site's files still hold the changes made after the backup

  Scenario: A files restore over WP-CLI brings the files back and leaves the database changed
    When I run the BackWPup restore command "restore {path to the newest backup} --yes --type=file"
    Then the command succeeds
    And it reports the success "Restore completed successfully."
    And the site's files are back as they were in the backup
    And the site's database still holds the changes made after the backup

  Scenario: A WP-CLI restore with a safety snapshot saves the site as it was before restoring the backup
    When I run the BackWPup restore command "restore {path to the newest backup} --yes --type=full --pre-backup"
    Then the command succeeds
    And it reports the success "Pre-backup created."
    And it reports the success "Restore completed successfully."
    And the restore's safety snapshot holds the site as it was before the restore
    And the site's files are back as they were in the backup
    And the site's database is back as it was in the backup
