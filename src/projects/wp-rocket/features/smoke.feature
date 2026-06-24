@wp-rocket @smoke @noauth
Feature: WP Rocket test runner scaffolding

  Scenario: The WP Rocket project is wired up
    Given a page titled "WP Rocket"
    Then the page title is "WP Rocket"
    And the heading mentions "WP Rocket"
    And the WP Rocket project marker is present
