# Driven by `reporting/results-stream.run.spec.ts` and `reporting/run-pruning.run.spec.ts` on a
# placeholder site, through the real `bddgen`, runner and the suite's reporters — never collected by a
# product, whose features live under `src/projects/`. Every scenario is `@noauth`: nothing here
# touches a site.
Feature: The results stream, end to end

  Background:
    Given a background step

  @noauth
  Scenario: A scenario that passes
    Given nothing else happens

  @noauth
  Scenario: A scenario that fails on its first attempt passes on its retry
    Given the first attempt fails

  @noauth
  Scenario: A scenario whose step fails on every attempt fails
    When a step fails with "boom"

  @noauth @failafter
  Scenario: A scenario whose After hook fails fails in that hook
    Given nothing else happens

  @noauth @hang
  Scenario: A scenario that hangs runs until the run is stopped
    Given the step waits until the run is stopped

  @noauth @nobaseline
  Scenario: A scenario whose screenshot has no baseline fails without a retry
    Then the page matches a screenshot that has no baseline

  # The last two, in this order: a drained run skips every first attempt after the stop file exists.
  @noauth
  Scenario: A scenario that asks the run to stop passes
    Given the run is asked to stop

  @noauth
  Scenario: A scenario that begins after the run is asked to stop is drained
    Given nothing else happens
