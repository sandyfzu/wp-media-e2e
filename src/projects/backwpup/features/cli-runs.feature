@plugin
Feature: Running BackWPup jobs over WP-CLI

  `wp backwpup run` starts a configured job in one of two places, and the difference is real. Run
  plainly, it backs the site up inside the WP-CLI process itself and prints the job's log as it goes.
  With `--background` it hands the job to the web server and returns at once — the way every
  scheduled or on-demand backup runs. BackWPup's own backup history records which: `wp-cli` for the
  first, `backup_now_job` for the second.

  A run is judged by what it left behind, never by the command's last line. A run in the foreground
  never gets as far as printing a verdict: the job ends the WP-CLI process itself once it is done, at
  exit 0, whatever it logged. A background start only reports that it asked. So these scenarios read
  the plugin's own record instead — the history row of each run, the log it wrote, the archive it
  left.

  The job backs up the database only, the smallest real backup a site can make.

  Background:
    Given BackWPup is set up to back up the "database" on a schedule

  Scenario: A job run in the foreground backs the site up inside WP-CLI, and the history says WP-CLI started it
    When I run the BackWPup command "run {job}" on the scheduled job
    Then the command succeeds
    And it streamed the log of the run it made
    And the backup history holds 1 completed run of the scheduled job, started by "wp-cli"
    And the scheduled job's newest log reports no errors and no warnings
    When I run the BackWPup command "backup --format=count"
    Then it prints "1"

  Scenario: A job run in the background is handed to the web server, and the history records it as started on demand
    When I run the BackWPup command "run {job} --background" on the scheduled job
    Then the command succeeds
    And it reports the success "runs now in background"
    When the scheduled job's run has ended
    Then the backup history holds 1 completed run of the scheduled job, started by "backup_now_job"
    And the scheduled job's newest log reports no errors and no warnings
    When I run the BackWPup command "backup --format=count"
    Then it prints "1"

  # The refusals quote the plugin's own wording, slips included. More than one id is refused before
  # any of them is looked up, which is why the ids in "1,2" need not exist.
  Scenario: Starting or activating a job by an id the command cannot use is refused, and nothing runs
    When I run the BackWPup command "run"
    Then the command fails
    And it reports the error "No job ID(s) or pram specified!"
    When I run the BackWPup command "run 1,2 --background"
    Then the command fails
    And it reports the error "Background job run not works with more than one job_id!"
    When I run the BackWPup command "run 999"
    Then the command fails
    And it reports the error "Job ID does not exist!"
    When I run the BackWPup command "job-activate --job_id=999"
    Then the command fails
    And it reports the error "No jobs found!"
    And the backup history holds no runs
    And the backup job is scheduled to run

  # Activating without `--type` takes WP-CLI's default from the command's own synopsis, `wpcron`.
  # The command falls back to a value of its own when no default reaches it, and that value is
  # misspelt ("wp-cron"), so this also proves the default still arrives.
  Scenario: Deactivating a job takes it off the schedule, and activating it again puts it back on WP-Cron
    When I run the BackWPup command "job-activate --job_id={job} --type=disable" on the scheduled job
    Then the command succeeds
    And it reports the success "deactivated"
    And the backup job is not scheduled to run
    When I run the BackWPup command "job --field=active_type"
    Then it prints "none"
    When I run the BackWPup command "job-activate --job_id={job}" on the scheduled job
    Then the command succeeds
    And it reports the success "changed to active type wpcron"
    And the backup job is scheduled to run
    When I run the BackWPup command "job --field=active_type"
    Then it prints "wpcron"
