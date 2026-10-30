CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS folders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT NULL,
  name VARCHAR(255) NOT NULL,
  created_by INT NOT NULL,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  folder_id INT NULL,
  name VARCHAR(255) NOT NULL,
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  size BIGINT NOT NULL DEFAULT 0,
  mime VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  status ENUM('pending','ready') NOT NULL DEFAULT 'pending',
  uploaded_by INT NOT NULL,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token CHAR(48) NOT NULL UNIQUE,
  file_id INT NOT NULL,
  created_by INT NOT NULL,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Files removed with "Delete forever" wait here before being erased from R2.
-- The app also creates this table automatically on startup.
CREATE TABLE IF NOT EXISTS purge_queue (
  id INT AUTO_INCREMENT PRIMARY KEY,
  r2_key VARCHAR(512) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  purge_after DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
