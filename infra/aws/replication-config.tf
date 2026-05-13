# infra/aws/replication-config.tf — O02 S3 CRR for prod backup bucket
# Replicates vici2-backups-prod (us-east-1) → vici2-backups-prod-dr (us-west-2).
# See spec/modules/O02/PLAN.md §11.

# ── Source bucket (us-east-1) ──────────────────────────────────────────────────
resource "aws_s3_bucket" "vici2_backups_prod" {
  provider = aws.us_east_1
  bucket   = "vici2-backups-prod"
}

resource "aws_s3_bucket_versioning" "vici2_backups_prod" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.vici2_backups_prod.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "vici2_backups_prod" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.vici2_backups_prod.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.vici2_backup_kek_prod.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "vici2_backups_prod" {
  provider                = aws.us_east_1
  bucket                  = aws_s3_bucket.vici2_backups_prod.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── DR bucket (us-west-2) ──────────────────────────────────────────────────────
resource "aws_s3_bucket" "vici2_backups_prod_dr" {
  provider = aws.us_west_2
  bucket   = "vici2-backups-prod-dr"
}

resource "aws_s3_bucket_versioning" "vici2_backups_prod_dr" {
  provider = aws.us_west_2
  bucket   = aws_s3_bucket.vici2_backups_prod_dr.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "vici2_backups_prod_dr" {
  provider = aws.us_west_2
  bucket   = aws_s3_bucket.vici2_backups_prod_dr.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.vici2_backup_kek_prod_dr.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "vici2_backups_prod_dr" {
  provider                = aws.us_west_2
  bucket                  = aws_s3_bucket.vici2_backups_prod_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── IAM replication role ───────────────────────────────────────────────────────
data "aws_iam_policy_document" "replication_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = "vici2-backup-s3-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_assume.json
}

data "aws_iam_policy_document" "replication_policy" {
  statement {
    actions = [
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.vici2_backups_prod.arn]
  }

  statement {
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.vici2_backups_prod.arn}/*"]
  }

  statement {
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    resources = ["${aws_s3_bucket.vici2_backups_prod_dr.arn}/*"]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.vici2_backup_kek_prod.arn]
  }

  statement {
    actions   = ["kms:Encrypt"]
    resources = [aws_kms_key.vici2_backup_kek_prod_dr.arn]
  }
}

resource "aws_iam_policy" "replication" {
  name   = "vici2-backup-s3-replication"
  policy = data.aws_iam_policy_document.replication_policy.json
}

resource "aws_iam_role_policy_attachment" "replication" {
  role       = aws_iam_role.replication.name
  policy_arn = aws_iam_policy.replication.arn
}

# ── Replication configuration ─────────────────────────────────────────────────
resource "aws_s3_bucket_replication_configuration" "prod" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.vici2_backups_prod.id
  role     = aws_iam_role.replication.arn

  depends_on = [aws_s3_bucket_versioning.vici2_backups_prod]

  rule {
    id       = "replicate-all-to-dr"
    status   = "Enabled"
    priority = 0

    filter {}

    destination {
      bucket        = aws_s3_bucket.vici2_backups_prod_dr.arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = aws_kms_key.vici2_backup_kek_prod_dr.arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    delete_marker_replication {
      # Do NOT propagate accidental deletes to DR
      status = "Disabled"
    }
  }
}

# ── CloudWatch alarm: replication lag ─────────────────────────────────────────
resource "aws_cloudwatch_metric_alarm" "replication_lag" {
  provider            = aws.us_east_1
  alarm_name          = "vici2-backup-replication-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReplicationLatency"
  namespace           = "AWS/S3"
  period              = 300
  statistic           = "Maximum"
  threshold           = 900  # 15 minutes
  alarm_description   = "vici2 backup CRR replication lag exceeded 15 minutes"

  dimensions = {
    SourceBucket      = aws_s3_bucket.vici2_backups_prod.id
    DestinationBucket = aws_s3_bucket.vici2_backups_prod_dr.id
    RuleId            = "replicate-all-to-dr"
  }
}
