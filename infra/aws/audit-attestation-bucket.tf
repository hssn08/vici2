# infra/aws/audit-attestation-bucket.tf
# Terraform stub for O02 to apply.
# C03 PLAN §5.5: S3 bucket for Merkle attestation artifacts with
# Object Lock Compliance, 7-year default retention, versioning, SSE-S3.
#
# NOTE: Object Lock MUST be enabled at bucket creation; it cannot be added
# retroactively. The bucket name must be globally unique — set via
# variable "attestation_bucket_name".

variable "attestation_bucket_name" {
  description = "S3 bucket name for vici2 audit attestations"
  type        = string
  default     = "vici2-audit-attestations"
}

variable "audit_attestation_retention_days" {
  description = "Object Lock Compliance retention in days (TCPA 7y = 2557 leap-safe)"
  type        = number
  default     = 2557
}

resource "aws_s3_bucket" "audit_attestations" {
  bucket        = var.attestation_bucket_name
  force_destroy = false # never allow destroy with locked objects

  tags = {
    Project     = "vici2"
    Component   = "C03-audit-immutability"
    Compliance  = "SOC2-CC7.2,TCPA,NIST-AU-9"
    ManagedBy   = "terraform"
  }
}

# Object Lock is enabled only at bucket creation — cannot be changed later.
resource "aws_s3_bucket_object_lock_configuration" "audit_attestations" {
  bucket = aws_s3_bucket.audit_attestations.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.audit_attestation_retention_days
    }
  }
}

# Versioning is required for Object Lock.
resource "aws_s3_bucket_versioning" "audit_attestations" {
  bucket = aws_s3_bucket.audit_attestations.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption (SSE-S3 for Phase 1; swap to SSE-KMS with CMK for Phase 4).
resource "aws_s3_bucket_server_side_encryption_configuration" "audit_attestations" {
  bucket = aws_s3_bucket.audit_attestations.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Block all public access.
resource "aws_s3_bucket_public_access_block" "audit_attestations" {
  bucket                  = aws_s3_bucket.audit_attestations.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bucket policy: only the audit writer IAM principal may PUT; reader may GET/LIST.
# The vici2_audit_writer IAM role ARN is injected by O02.
data "aws_iam_policy_document" "audit_attestations" {
  statement {
    sid     = "AllowAuditWriterPut"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit_attestations.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = [var.audit_writer_iam_role_arn]
    }
  }

  statement {
    sid     = "AllowAuditReaderGet"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.audit_attestations.arn,
      "${aws_s3_bucket.audit_attestations.arn}/*",
    ]
    principals {
      type        = "AWS"
      identifiers = [var.audit_reader_iam_role_arn]
    }
  }

  statement {
    sid     = "DenyDeleteAndDescribeForAll"
    effect  = "Deny"
    actions = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.audit_attestations.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit_attestations" {
  bucket = aws_s3_bucket.audit_attestations.id
  policy = data.aws_iam_policy_document.audit_attestations.json
}

variable "audit_writer_iam_role_arn" {
  description = "IAM role ARN for the audit attestation worker (may PutObject)"
  type        = string
}

variable "audit_reader_iam_role_arn" {
  description = "IAM role ARN for the audit reader / verifier (may GetObject, ListBucket)"
  type        = string
}

output "audit_attestations_bucket_name" {
  value = aws_s3_bucket.audit_attestations.id
}

output "audit_attestations_bucket_arn" {
  value = aws_s3_bucket.audit_attestations.arn
}
