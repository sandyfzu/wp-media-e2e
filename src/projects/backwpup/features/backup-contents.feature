@plugin
Feature: What a BackWPup backup actually holds

  An archive that exists, weighs the right number of bytes and downloads intact still says nothing
  about what is inside it. These scenarios plant two known-unique values in the site — one in a file
  under wp-content, one in the database — run a real backup, and read the archive back to see which
  of them it captured. The values are random per scenario, so finding one proves the run captured the
  site as it was at that moment; a fixed value would be satisfied just as well by a stale archive.

  Both markers are planted for every scenario, so each one asserts what its job covered *and* what it
  left alone. That is the difference between "a backup ran" and "the backup covered what it was
  configured to cover": a database job that swept the filesystem in, or a files job that quietly
  dumped the database, would sail through a presence-only check.

  The archive is inspected where it lies rather than downloaded. A files backup of a real site runs to
  gigabytes, and moving one across the wire per assertion would cost more than the rest of the suite
  together. Downloading is covered on its own, against the smallest archive a site can make.

  Background:
    Given the site holds marker data in its files and in its database

  Scenario: A database backup captures the database and leaves the files out
    Given BackWPup is set up to back up the "database" on a schedule
    When a backup runs
    Then the archive holds the database marker
    And the archive holds no file marker

  Scenario: A files backup captures the files and leaves the database out
    Given BackWPup is set up to back up the "files" on a schedule
    When a backup runs
    Then the archive holds the file marker
    And the archive holds no database marker

  Scenario: A backup of files and database together captures both
    Given BackWPup is set up to back up the "files and database" on a schedule
    When a backup runs
    Then the archive holds the file marker
    And the archive holds the database marker
