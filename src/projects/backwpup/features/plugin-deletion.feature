@plugin
Feature: Deleting BackWPup from the plugins screen

  Deleting a plugin through wp-admin is not the same as removing its files. WordPress core's
  `delete_plugins()` calls `uninstall_plugin()` first — read from WP 7.1.1 on the cells — which is
  where a plugin clears what it wrote to the database. `wp plugin delete` skips that step entirely,
  so this screen is the only place the complete removal a user actually performs can be observed.

  Each scenario therefore asserts both halves of what deletion means: the plugin is gone, and so is
  everything it had put in the database — its options, its table, the roles it registered, the
  capabilities it granted the administrator and the user meta its notices wrote. The suite the port
  replaces checked only that WordPress rendered its "plugin deleted" element, which says nothing
  about any of that.

  Every scenario starts from an installed, activated plugin, because that is what the lifecycle
  guarantees; what differs is the state the plugin is in when the user reaches for Delete, and how
  much it had written by then.

  Scenario: Deleting a deactivated plugin removes it and everything it put in the database
    Given BackWPup is deactivated
    When I delete BackWPup from the plugins screen
    Then BackWPup is no longer installed on the site
    And the site holds nothing of BackWPup in its database

  # WordPress only offers Delete for an inactive plugin, so the flow has to deactivate first. Worth
  # its own scenario because that extra step is where the deletion can be lost: a Delete click that
  # lands before the row has re-rendered acts on a stale link and quietly does nothing.
  Scenario: Deleting an active plugin deactivates it first and still removes it completely
    When I delete BackWPup from the plugins screen
    Then BackWPup is no longer installed on the site
    And the site holds nothing of BackWPup in its database

  # The bargain a backup plugin's uninstall has to keep: the settings are the plugin's to remove, the
  # archives are the user's to keep. Asserting only the first half would pass just as well for an
  # uninstall that deleted the site's backups along with them.
  Scenario: Deleting the plugin after it has made a backup clears its settings but keeps the archive
    Given BackWPup is set up to back up the "database" on a schedule
    And the site has already made 1 backup
    When I delete BackWPup from the plugins screen
    Then BackWPup is no longer installed on the site
    And the site holds nothing of BackWPup in its database
    And the 1 backup it had made is still on the site
