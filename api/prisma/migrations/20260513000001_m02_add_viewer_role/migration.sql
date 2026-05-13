-- M02 amendment: F02 amendment A7 — add `viewer` to UserRole enum
-- viewer is a read-only role for SOC 2 auditors / compliance officers.
-- It is orthogonal to the hierarchy (not between agent and supervisor).

ALTER TABLE `users`
  MODIFY COLUMN `role` ENUM('agent','supervisor','admin','superadmin','integrator','viewer')
  NOT NULL DEFAULT 'agent';
