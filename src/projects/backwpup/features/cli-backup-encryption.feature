@pro @plugin
Feature: Encrypting and decrypting BackWPup backups over WP-CLI

  `wp backwpup backup-encrypt` encrypts a backup archive and `backup-decrypt` decrypts it — both
  BackWPup Pro commands, both **in place, under the archive's own name**. So the name proves nothing:
  what they did is read off the archive itself, on the site — its first bytes are BackWPup's header
  when it is encrypted, naming the kind of key — and a decrypt is held to the digest the archive had
  when its run made it, byte for byte. Neither command's own line is taken as proof.

  Both take the archive as a path, which `{path to the newest backup}` gives relative to the directory
  WP-CLI runs in. The key is a hex string, or a key file: a public key encrypts, only its private key
  decrypts. Every key is drawn for the scenario and named by a placeholder — `{encryption key}`,
  `{another encryption key}`, `{public key file}`, `{private key file}` — never written here. Without
  `--key`, both use the key saved in BackWPup's settings.

  Kept out of these scenarios' way, each a plugin bug: encrypting without a key on a site whose
  encryption settings were never saved, which destroys the archive and reports success; a hex key of
  the wrong length, which crashes the encrypt; and encrypting an archive twice, which the plugin
  cannot undo. The job backs up the database only, inside WP-CLI, with the jobs' own archive
  encryption off — so every backup here starts out plain.

  Background:
    Given BackWPup is set up to back up the "database" on a schedule
    And the scheduled job has made 1 backup inside WP-CLI

  Scenario: Encrypting a backup with a hex key replaces it in place, and decrypting it with the same key restores it byte for byte
    When I run the BackWPup command "backup-encrypt {path to the newest backup} --key={encryption key}"
    Then the command succeeds
    And it reports the success "Archive has been successfully encrypted."
    And the newest backup is encrypted with a symmetric key
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key={encryption key}"
    Then the command succeeds
    And it reports the success "Archive has been successfully decrypted."
    And the newest backup is still on the site, byte for byte
    And nothing is left beside the newest backup

  Scenario: Encrypting a backup with a public key file makes it one that only the private key file decrypts
    When I run the BackWPup command "backup-encrypt {path to the newest backup} --key={public key file}"
    Then the command succeeds
    And the newest backup is encrypted with a public key
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key={public key file}"
    Then the command fails
    And it reports the error "The key that was loaded was not a private key"
    And the newest backup is encrypted with a public key
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key={private key file}"
    Then the command succeeds
    And the newest backup is still on the site, byte for byte
    And nothing is left beside the newest backup

  Scenario: With an encryption key saved in BackWPup's settings, a backup encrypts and decrypts without --key
    Given BackWPup's encryption key is saved in its settings
    When I run the BackWPup command "backup-encrypt {path to the newest backup}"
    Then the command succeeds
    And the newest backup is encrypted with a symmetric key
    When I run the BackWPup command "backup-decrypt {path to the newest backup}"
    Then the command succeeds
    And the newest backup is still on the site, byte for byte
    And nothing is left beside the newest backup

  # The right key restoring the original afterwards is what proves the refused attempt left the
  # encrypted archive untouched: a decrypt of a changed file could not give back the recorded digest.
  Scenario: Decrypting a backup with the wrong key is refused, and the right key still restores it byte for byte
    When I run the BackWPup command "backup-encrypt {path to the newest backup} --key={encryption key}"
    Then the command succeeds
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key={another encryption key}"
    Then the command fails
    And it reports the error "Archive could not be decrypted. Maybe wrong key!"
    And the newest backup is encrypted with a symmetric key
    And nothing is left beside the newest backup
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key={encryption key}"
    Then the command succeeds
    And the newest backup is still on the site, byte for byte

  Scenario: Encrypt and decrypt refuse a key that is not hex, a file that is not there and a backup that is not encrypted, and leave the backup byte for byte
    When I run the BackWPup command "backup-encrypt {path to the newest backup} --key=xyz"
    Then the command fails
    And it reports the error "Key must be a string of hexadecimal characters!"
    And the newest backup is still on the site, byte for byte
    When I run the BackWPup command "backup-encrypt no-such-backup.tar --key={encryption key}"
    Then the command fails
    And it reports the error "Archive file that should be encrypted can't be found!"
    And the newest backup is still on the site, byte for byte
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key=xyz"
    Then the command fails
    And it reports the error "Key must be a string of hexadecimal characters!"
    And the newest backup is still on the site, byte for byte
    When I run the BackWPup command "backup-decrypt no-such-backup.tar --key={encryption key}"
    Then the command fails
    And it reports the error "Archive file that should be decrypted can't be found!"
    And the newest backup is still on the site, byte for byte
    When I run the BackWPup command "backup-decrypt {path to the newest backup} --key={encryption key}"
    Then the command fails
    And it reports the error "Archive not needs decryption."
    And the newest backup is still on the site, byte for byte
    And nothing is left beside the newest backup
