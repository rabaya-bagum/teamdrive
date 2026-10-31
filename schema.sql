-- Full schema for a fresh install. Existing installs are upgraded automatically
-- when the app starts, so you never need to re-run this after an update.

-- Each customer company is a team. Everything below belongs to exactly one team.
CREATE TABLE IF NOT EXISTS teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  quota_bytes BIGINT NULL,
  trial_ends_at DATETIME NULL,
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  is_owner TINYINT(1) NOT NULL DEFAULT 0,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  totp_secret VARCHAR(255) NULL,
  totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  totp_last_step BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_team (team_id)
);

CREATE TABLE IF NOT EXISTS folders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NULL,
  parent_id INT NULL,
  name VARCHAR(255) NOT NULL,
  created_by INT NOT NULL,
  restricted TINYINT(1) NOT NULL DEFAULT 0,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_folders_team (team_id, parent_id),
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NULL,
  folder_id INT NULL,
  name VARCHAR(255) NOT NULL,
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  size BIGINT NOT NULL DEFAULT 0,
  mime VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  status ENUM('pending','ready') NOT NULL DEFAULT 'pending',
  uploaded_by INT NOT NULL,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  INDEX idx_files_team (team_id, folder_id),
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token CHAR(48) NOT NULL UNIQUE,
  file_id INT NOT NULL,
  created_by INT NOT NULL,
  expires_at DATETIME NULL,
  password_hash VARCHAR(255) NULL,
  downloads INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Older copies of a file, created when a same-name file is uploaded to the same folder.
CREATE TABLE IF NOT EXISTS file_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_id INT NOT NULL,
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  size BIGINT NOT NULL DEFAULT 0,
  mime VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  uploaded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

-- Members allowed into a restricted folder (admins and the creator always are).
CREATE TABLE IF NOT EXISTS folder_access (
  folder_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (folder_id, user_id),
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Files removed with "Delete forever" wait here before being erased from R2.
CREATE TABLE IF NOT EXISTS purge_queue (
  id INT AUTO_INCREMENT PRIMARY KEY,
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  purge_after DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Two-step login: one-time backup codes (stored hashed).
CREATE TABLE IF NOT EXISTS backup_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME NULL,
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Two-step login: "trust this device for 30 days" tokens (stored hashed).
CREATE TABLE IF NOT EXISTS trusted_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (token_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Who did what, per team. Kept for ACTIVITY_DAYS (default 365).
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL,
  user_id INT NULL,
  action VARCHAR(40) NOT NULL,
  target_type VARCHAR(20) NULL,
  target_id INT NULL,
  target_name VARCHAR(255) NULL,
  detail VARCHAR(500) NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_activity_team (team_id, id),
  INDEX idx_activity_user (team_id, user_id, id)
);

-- "Request access" form on the landing page. Deleted after 12 months.
CREATE TABLE IF NOT EXISTS access_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(200) NOT NULL,
  company VARCHAR(160) NOT NULL,
  team_size VARCHAR(40) NOT NULL,
  hosting VARCHAR(60) NULL,
  message TEXT NULL,
  ip VARCHAR(64) NULL,
  handled_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Small key/value store for app housekeeping (e.g. when the public demo was last reset).
CREATE TABLE IF NOT EXISTS app_state (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT NULL
);
