<?php
/**
 * Runs one `wp eval` snippet against a fake `$wpdb`, for `table-padding.php.spec.ts`.
 *
 * Usage: php fake-wpdb.php <snippet.php> <state.json>
 *
 * The state file holds the database — `prefix`, `tables`, and optionally `fail_create_at` (a table
 * count at which CREATE TABLE fails) — and is written back afterwards, so a sequence of calls replays
 * a sequence of runs. Prints JSON: the snippet's output, or the WP_CLI::error() it stopped with, and
 * every statement it sent.
 *
 * `esc_like()` and `prepare()` behave as WordPress's do, and `SHOW TABLES LIKE` reads its pattern as
 * MySQL does — `\x` a literal, `_` any one character, `%` any run — so an unescaped stem would match
 * more than it should, as it would on a real server.
 */

class FakeWpdb {
	public $prefix;
	public $last_error = '';
	public $tables;
	public $fail_create_at;
	public $statements = [];

	public function __construct( array $state ) {
		$this->prefix         = $state['prefix'];
		$this->tables         = $state['tables'];
		$this->fail_create_at = $state['fail_create_at'] ?? null;
	}

	public function esc_like( $text ) {
		return addcslashes( $text, '_%\\' );
	}

	public function prepare( $query, $arg ) {
		return str_replace( '%s', "'" . addslashes( $arg ) . "'", $query );
	}

	public function get_col( $sql ) {
		if ( 'SHOW FULL TABLES' === $sql ) {
			return $this->tables;
		}
		if ( preg_match( "/^SHOW TABLES LIKE '(.*)'$/s", $sql, $match ) ) {
			return array_values( preg_grep( self::like_to_regex( stripslashes( $match[1] ) ), $this->tables ) );
		}
		throw new LogicException( "unexpected get_col: $sql" );
	}

	public function query( $sql ) {
		$this->statements[] = $sql;
		if ( preg_match( '/^DROP TABLE IF EXISTS `([^`]+)`$/', $sql, $match ) ) {
			$this->tables = array_values( array_diff( $this->tables, [ $match[1] ] ) );
			return true;
		}
		if ( preg_match( '/^CREATE TABLE `([^`]+)` \( id INT NOT NULL PRIMARY KEY \)$/', $sql, $match ) ) {
			if ( null !== $this->fail_create_at && count( $this->tables ) >= $this->fail_create_at ) {
				$this->last_error = 'The table is full';
				return false;
			}
			if ( in_array( $match[1], $this->tables, true ) ) {
				$this->last_error = "Table '{$match[1]}' already exists";
				return false;
			}
			$this->tables[] = $match[1];
			return true;
		}
		throw new LogicException( "unexpected query: $sql" );
	}

	private static function like_to_regex( $pattern ) {
		$regex = '';
		for ( $i = 0, $n = strlen( $pattern ); $i < $n; $i++ ) {
			$char = $pattern[ $i ];
			if ( '\\' === $char && $i + 1 < $n ) {
				$regex .= preg_quote( $pattern[ ++$i ], '/' );
			} elseif ( '_' === $char ) {
				$regex .= '.';
			} elseif ( '%' === $char ) {
				$regex .= '.*';
			} else {
				$regex .= preg_quote( $char, '/' );
			}
		}
		return '/^' . $regex . '$/s';
	}
}

class WP_CLI {
	public static function error( $message ) {
		throw new RuntimeException( $message );
	}
}

function wp_json_encode( $value ) {
	return json_encode( $value );
}

[ , $snippet, $state_file ] = $argv;
$wpdb  = new FakeWpdb( json_decode( file_get_contents( $state_file ), true ) );
$error = null;
ob_start();
try {
	( static function () use ( $snippet ) {
		global $wpdb;
		include $snippet;
	} )();
} catch ( RuntimeException $e ) {
	$error = $e->getMessage();
}
$output = ob_get_clean();
file_put_contents( $state_file, json_encode( [ 'prefix' => $wpdb->prefix, 'tables' => $wpdb->tables, 'fail_create_at' => $wpdb->fail_create_at ] ) );
echo json_encode( [ 'output' => $output, 'error' => $error, 'statements' => $wpdb->statements ] );
