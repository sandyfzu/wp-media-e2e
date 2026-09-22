@plugin
Feature: Asking BackWPup about a site over WP-CLI

  BackWPup registers a command surface of its own under `wp backwpup`, in Free as well as Pro, and a
  site's jobs, archives and logs can all be read from it. These scenarios cover the half of that
  surface that only asks questions: which commands exist, which plugin is installed, what the site
  holds, and what the two commands that follow a running job answer when none is.

  The command **is** the system under test here, not a way of setting one up, so a non-zero exit is
  something to assert rather than a broken arrangement — how this surface refuses is half of what it
  promises. Which commands are registered is checked first and separately, because every other
  scenario addresses one by name, and a name that stopped being registered answers with an empty
  list that an assertion about an empty site would happily pass.

  Every count is read back against a source the command has no hand in: the jobs the site stores,
  the backups its history records, the zip the run installed. The suite this ports asserted a job
  count by parsing one command's output and comparing it to a number written in the feature, which
  cannot tell a miscount from a command that was never reached.

  # The install is finished before any command runs. BackWPup defers its own activation to the
  # first request that loads it, so without this the command under test would be that request —
  # racing the site's cron to set the plugin up, with a lost race showing only as a wrong answer.
  Background:
    Given a freshly installed BackWPup

  # ── Which commands exist ─────────────────────────────────────────────────────

  Scenario: BackWPup registers exactly the commands its edition ships and nothing besides
    Then the site registers exactly the BackWPup commands its edition ships

  Scenario: The commands only BackWPup Pro ships are available on Pro and unknown on Free
    Then the commands only BackWPup Pro ships are available on Pro and unknown on Free

  # The wording matters beyond this scenario: it is what a mistyped or renamed command anywhere in
  # the surface fails as, instead of failing as a command that answered with nothing.
  Scenario: A name BackWPup does not register is refused as the unknown command it is
    When I run the BackWPup command "no-such-command"
    Then the command fails
    And it reports the error "'no-such-command' is not a registered subcommand of 'backwpup'"

  Scenario: The version command names the edition and version of the plugin the cell installed
    When I run the BackWPup command "version"
    Then the command succeeds
    And it prints the name and version of the plugin under test

  # ── A site that holds nothing yet ────────────────────────────────────────────

  # Worth its own scenario because an empty answer is the easiest one to get wrong in both
  # directions: none of these three commands fails on an empty site, and `log` does not even answer
  # in JSON — it says so in a sentence, and still exits zero.
  Scenario: A site that has configured nothing lists no jobs, no backups and no logs
    When I run the BackWPup command "job --format=json"
    Then the command succeeds
    And it prints "[]"
    When I run the BackWPup command "job --format=ids"
    Then the ids it printed are the site's own jobs, with BackWPup's hidden ones left out
    When I run the BackWPup command "backup --format=json"
    Then the command succeeds
    And it prints "[]"
    When I run the BackWPup command "log"
    Then the command succeeds
    And it prints "No logs found."

  Scenario: With no job running, watching and aborting both report there is nothing to do
    When I run the BackWPup command "status"
    Then the command succeeds
    And it reports the success "No job running."
    When I run the BackWPup command "kill"
    Then the command succeeds
    And it reports the success "Nothing to abort."

  # ── Reading the jobs a site has configured ───────────────────────────────────

  Scenario: The job list can be counted, cut to chosen fields, and filtered by what a job backs up
    Given BackWPup is set up to back up the "database" on a schedule
    When I run the BackWPup command "job --format=count"
    Then it prints "1"
    When I run the BackWPup command "job --field=job_id"
    Then the command succeeds
    And the ids it printed are the site's own jobs, with BackWPup's hidden ones left out
    When I run the BackWPup command "job --fields=job_id,type --format=json"
    Then the command succeeds
    And every record it lists carries exactly the fields "job_id,type"
    # The filter matches a field's value as a substring, whatever the case. The second half is what
    # makes the first mean something: a filter that matched everything would pass the line above.
    When I run the BackWPup command "job --type=DBDUMP --format=count"
    Then it prints "1"
    When I run the BackWPup command "job --type=file --format=count"
    Then it prints "0"

  # The job has to be arranged first, and that is the whole point of the Given: the command returns
  # before it ever looks at the field when the list is empty, so on a bare site this same line
  # passes at exit zero against a command that validated nothing.
  Scenario: Asking the job list for a field it does not have is refused by name
    Given BackWPup is set up to back up the "database" on a schedule
    When I run the BackWPup command "job --field=nope"
    Then the command fails
    And it reports the error "Invalid field: nope"

  # The count the suite this ports was written for, on the state it was written against — but taken
  # against what the site stores rather than against a number typed into the feature twice.
  Scenario: The job count follows the jobs a user configured, from the first one to the third
    Given BackWPup is set up to back up the "database" on a schedule
    When I run the BackWPup command "job --format=count"
    Then it prints "1"
    When I run the BackWPup command "job --format=ids"
    Then the ids it printed are the site's own jobs, with BackWPup's hidden ones left out
    When 2 more backup jobs are added
    And I run the BackWPup command "job --format=count"
    Then it prints "3"
    When I run the BackWPup command "job --format=ids"
    Then the ids it printed are the site's own jobs, with BackWPup's hidden ones left out

  # Every command registers a second name of its own, and these two are the ones the ported suite
  # addressed instead of the canonical `job` and `backup`. They still resolve, so the port proves it
  # once here and drives the canonical names everywhere else.
  Scenario: The plural aliases for the job and backup lists answer like the commands they name
    Given BackWPup is set up to back up the "database" on a schedule
    When I run the BackWPup command "jobs --format=count"
    Then it prints "1"
    When I run the BackWPup command "backups --format=count"
    Then it prints "0"

  # ── Reading what a run left behind ───────────────────────────────────────────

  Scenario: After a backup has run, the backup and log lists each report that one run
    Given BackWPup is set up to back up the "database" on a schedule
    And the site has already made 1 backup
    When I run the BackWPup command "backup --format=count"
    Then it prints "1"
    When I run the BackWPup command "backup --field=name"
    Then the command succeeds
    And it names the archives the backup history records
    When I run the BackWPup command "log --format=count"
    Then it prints "1"
    And the log list filtered by job holds the scheduled job's run and no other job's
    When I run the BackWPup command "log --fields=name,job_id,errors,warnings --format=json"
    Then the command succeeds
    And the log it lists is the scheduled job's, with no errors and no warnings
