@plugin @slow
Feature: Restoring a BackWPup backup from the backup history

  Each scenario plants one known value in the site's files and one in its database, backs the site
  up, then changes both values. A restore is judged by which value each one holds afterwards: the
  half it was meant to restore must hold the backed-up value again, and the half it was meant to
  leave alone must still hold the changed one — so a restore that does nothing, everything, or the
  wrong half fails.

  How the restore screen is reached differs by edition. Pro's Restore action links straight to the
  archive already on the server, which the server copies itself; Free's lands on an empty restore
  screen, so the archive has to be downloaded and uploaded again. Each edition's scenario asserts its
  own journey and refuses the other's.

  The strategy screen offers what the archive can serve: a backup of files and database offers a
  full, a database-only and a files-only restore; a backup of one half offers that half alone.

  Background:
    Given the site holds marker data in its files and in its database

  @pro
  Scenario: A full restore from the backup history brings the site's files and database back
    Given BackWPup is set up to back up the "files and database" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup
    When I open the BackWPup dashboard
    And I restore the newest backup from the backup history, choosing "Full Restore"
    Then the restore screen offered "Full Restore", "Database Only" and "Files Only"
    And the site's files are back as they were in the backup
    And the site's database is back as it was in the backup

  @pro
  Scenario: A database-only restore of a full backup brings the database back and leaves the files changed
    Given BackWPup is set up to back up the "files and database" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup
    When I open the BackWPup dashboard
    And I restore the newest backup from the backup history, choosing "Database Only"
    Then the site's database is back as it was in the backup
    And the site's files still hold the changes made after the backup

  @pro
  Scenario: A files-only restore of a full backup brings the files back and leaves the database changed
    Given BackWPup is set up to back up the "files and database" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup
    When I open the BackWPup dashboard
    And I restore the newest backup from the backup history, choosing "Files Only"
    Then the site's files are back as they were in the backup
    And the site's database still holds the changes made after the backup

  @pro
  Scenario: Restoring a database-only backup offers only a database restore and brings the database back
    Given BackWPup is set up to back up the "database" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup
    When I open the BackWPup dashboard
    And I restore the newest backup from the backup history, choosing "Database Only"
    Then the restore screen offered only "Database Only"
    And the site's database is back as it was in the backup
    And the site's files still hold the changes made after the backup

  @pro
  Scenario: Restoring a files-only backup offers only a files restore and brings the files back
    Given BackWPup is set up to back up the "files" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup
    When I open the BackWPup dashboard
    And I restore the newest backup from the backup history, choosing "Files Only"
    Then the restore screen offered only "Files Only"
    And the site's files are back as they were in the backup
    And the site's database still holds the changes made after the backup

  @free
  Scenario: Restoring by uploading the downloaded backup brings the site's files and database back
    Given BackWPup is set up to back up the "files and database" on a schedule
    And the scheduled job has made 1 backup through the web server
    And the site's marker data has changed since that backup
    When I open the BackWPup dashboard
    And I download the newest backup
    And I restore the newest backup from the backup history by uploading it, choosing "Full Restore"
    Then the restore screen offered "Full Restore", "Database Only" and "Files Only"
    And the site's files are back as they were in the backup
    And the site's database is back as it was in the backup
