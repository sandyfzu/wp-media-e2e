# Driven by `config/drain.run.spec.ts` on a placeholder site, through the real `bddgen`, runner and
# shared hooks — never collected by a product, whose features live under `src/projects/`.
Feature: The drain, end to end

  # Its first attempt asks the run to stop, then fails: the drain must still give it its retry.
  @noauth
  Scenario: A scenario that fails once after the run is asked to stop still gets its retry
    Given the run is asked to stop during the first attempt, which then fails

  # Starts after the stop file exists. On a placeholder site its login and its install would both
  # fail, so it reads skipped only if the gate runs first and its teardown leaves it alone.
  @plugin
  Scenario: A plugin scenario that begins after the run is asked to stop is skipped untouched
    Given nothing else happens
