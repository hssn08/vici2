# infra/aws/kms-keys.tf — O02 backup KMS keys (provisioned by O05)
# Owned by O05 (security baseline). O02 references these via alias.
# Separate from the app KEK (alias/vici2-app-kek-*) — blast-radius isolation.
# See spec/modules/O02/PLAN.md §10.

# ── Prod KMS key (us-east-1) ──────────────────────────────────────────────────
resource "aws_kms_key" "vici2_backup_kek_prod" {
  provider                = aws.us_east_1
  description             = "vici2 backup KEK — prod (us-east-1)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = data.aws_iam_policy_document.backup_kek_prod.json

  tags = {
    Name    = "vici2-backup-kek-prod"
    Service = "vici2"
    Module  = "O02"
    Env     = "prod"
  }
}

resource "aws_kms_alias" "vici2_backup_kek_prod" {
  provider      = aws.us_east_1
  name          = "alias/vici2-backup-kek-prod"
  target_key_id = aws_kms_key.vici2_backup_kek_prod.key_id
}

# ── Prod DR KMS key (us-west-2 — CRR destination) ────────────────────────────
resource "aws_kms_key" "vici2_backup_kek_prod_dr" {
  provider                = aws.us_west_2
  description             = "vici2 backup KEK — prod-dr (us-west-2)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = data.aws_iam_policy_document.backup_kek_prod_dr.json

  tags = {
    Name    = "vici2-backup-kek-prod-dr"
    Service = "vici2"
    Module  = "O02"
    Env     = "prod"
  }
}

resource "aws_kms_alias" "vici2_backup_kek_prod_dr" {
  provider      = aws.us_west_2
  name          = "alias/vici2-backup-kek-prod-dr"
  target_key_id = aws_kms_key.vici2_backup_kek_prod_dr.key_id
}

# ── Staging KMS key (us-east-1) ───────────────────────────────────────────────
resource "aws_kms_key" "vici2_backup_kek_staging" {
  provider                = aws.us_east_1
  description             = "vici2 backup KEK — staging"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = {
    Name    = "vici2-backup-kek-staging"
    Service = "vici2"
    Module  = "O02"
    Env     = "staging"
  }
}

resource "aws_kms_alias" "vici2_backup_kek_staging" {
  provider      = aws.us_east_1
  name          = "alias/vici2-backup-kek-staging"
  target_key_id = aws_kms_key.vici2_backup_kek_staging.key_id
}

# ── Key policies ──────────────────────────────────────────────────────────────
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "backup_kek_prod" {
  # Write role: can encrypt + generate data keys
  statement {
    sid     = "BackupWriteEncrypt"
    effect  = "Allow"
    actions = ["kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/vici2-backup-write"]
    }
    resources = ["*"]
  }

  # Read/restore role: can decrypt
  statement {
    sid     = "BackupReadDecrypt"
    effect  = "Allow"
    actions = ["kms:Decrypt", "kms:DescribeKey"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/vici2-backup-read"]
    }
    resources = ["*"]
  }

  # Rotate role: can re-encrypt (O05 uses for full re-encryption pass)
  statement {
    sid     = "BackupRotateReEncrypt"
    effect  = "Allow"
    actions = ["kms:ReEncrypt*", "kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/vici2-backup-rotate"]
    }
    resources = ["*"]
  }

  # S3 replication service
  statement {
    sid     = "S3ReplicationEncrypt"
    effect  = "Allow"
    actions = ["kms:Decrypt"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    resources = ["*"]
  }

  # Key administrators (O05 only — never root)
  statement {
    sid     = "KeyAdminAccess"
    effect  = "Allow"
    actions = ["kms:*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/vici2-kms-admin"]
    }
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "backup_kek_prod_dr" {
  statement {
    sid     = "BackupReadDecrypt"
    effect  = "Allow"
    actions = ["kms:Decrypt", "kms:DescribeKey"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/vici2-backup-read"]
    }
    resources = ["*"]
  }

  statement {
    sid     = "S3ReplicationEncrypt"
    effect  = "Allow"
    actions = ["kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey", "kms:DescribeKey"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    resources = ["*"]
  }

  statement {
    sid     = "KeyAdminAccess"
    effect  = "Allow"
    actions = ["kms:*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/vici2-kms-admin"]
    }
    resources = ["*"]
  }
}
