# =============================================================================
# infra/aws/recordings-bucket.tf — S3 recordings bucket + KMS CMK skeleton
# =============================================================================
# O05 PLAN §10.1: O05 owns the KMS key + IAM policy + bucket config.
# R02 (download endpoint) and R03 (worker upload) consume this module.
#
# Hand-off: R02/R03 IMPLEMENT must set VICI2_RECORDINGS_BUCKET and
# VICI2_RECORDINGS_KMS_KEY_ID in their service environments.
#
# Properties:
#   - S3 Object Lock: COMPLIANCE mode, 4-year retention (TCPA statute)
#   - SSE-KMS with customer-managed CMK
#   - Versioning: mandatory (Object Lock requires it)
#   - Bucket policy: deny non-HTTPS and block public ACLs
#   - IAM role: upload (workers), download-presign (api), admin (ops)
#
# Usage: include this module from your root Terraform config.
#   module "recordings" {
#     source      = "./infra/aws/recordings-bucket"
#     environment = "prod"
#     tenant_id   = "1"
#   }
# =============================================================================

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40"
    }
  }
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------
variable "environment" {
  description = "Deployment environment (prod, staging, dev)"
  type        = string
}

variable "tenant_id" {
  description = "Tenant ID (Phase 1: always 1)"
  type        = string
  default     = "1"
}

variable "retention_days" {
  description = "Object Lock compliance retention period in days (default 4 years = 1461)"
  type        = number
  default     = 1461
}

variable "aws_region" {
  description = "AWS region for the recordings bucket"
  type        = string
  default     = "us-east-1"
}

# ---------------------------------------------------------------------------
# KMS Customer-Managed Key for recording encryption
# ---------------------------------------------------------------------------
resource "aws_kms_key" "recordings" {
  description             = "vici2 recordings SSE-KMS CMK (tenant ${var.tenant_id}, ${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name        = "vici2-recordings-kms-${var.environment}"
    Environment = var.environment
    TenantId    = var.tenant_id
    ManagedBy   = "terraform"
    Module      = "O05"
  }
}

resource "aws_kms_alias" "recordings" {
  name          = "alias/vici2-recordings-${var.environment}"
  target_key_id = aws_kms_key.recordings.key_id
}

# ---------------------------------------------------------------------------
# S3 Bucket
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "recordings" {
  bucket = "vici2-recordings-${var.environment}-${var.tenant_id}"

  # Prevent accidental bucket deletion
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "vici2-recordings-${var.environment}"
    Environment = var.environment
    TenantId    = var.tenant_id
    ManagedBy   = "terraform"
    Module      = "O05"
  }
}

# Versioning (mandatory for Object Lock)
resource "aws_s3_bucket_versioning" "recordings" {
  bucket = aws_s3_bucket.recordings.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Object Lock — COMPLIANCE mode, 4-year retention
resource "aws_s3_bucket_object_lock_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.recordings]
}

# SSE-KMS encryption by default
resource "aws_s3_bucket_server_side_encryption_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.recordings.key_id
    }
    bucket_key_enabled = true
  }
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "recordings" {
  bucket                  = aws_s3_bucket.recordings.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bucket policy: deny non-HTTPS requests
resource "aws_s3_bucket_policy" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonHTTPS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.recordings.arn,
          "${aws_s3_bucket.recordings.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.recordings]
}

# ---------------------------------------------------------------------------
# IAM: Worker upload role (R03 workers service)
# ---------------------------------------------------------------------------
resource "aws_iam_policy" "recordings_upload" {
  name        = "vici2-recordings-upload-${var.environment}"
  description = "Allow vici2 workers to upload recordings to S3 (R03)"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowPut"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.recordings.arn}/*"
      },
      {
        Sid    = "AllowKMSEncrypt"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt"
        ]
        Resource = aws_kms_key.recordings.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# IAM: API presign role (R02 api download endpoint)
# ---------------------------------------------------------------------------
resource "aws_iam_policy" "recordings_presign" {
  name        = "vici2-recordings-presign-${var.environment}"
  description = "Allow vici2 api to generate signed download URLs (R02)"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowPresign"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.recordings.arn}/*"
      },
      {
        Sid    = "AllowKMSDecrypt"
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.recordings.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Outputs (consumed by R02/R03 service configs)
# ---------------------------------------------------------------------------
output "bucket_name" {
  description = "S3 bucket name — set as VICI2_RECORDINGS_BUCKET"
  value       = aws_s3_bucket.recordings.id
}

output "bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.recordings.arn
}

output "kms_key_id" {
  description = "KMS key ID — set as VICI2_RECORDINGS_KMS_KEY_ID"
  value       = aws_kms_key.recordings.key_id
}

output "kms_key_arn" {
  description = "KMS key ARN"
  value       = aws_kms_key.recordings.arn
}

output "upload_policy_arn" {
  description = "IAM policy ARN for R03 workers upload role"
  value       = aws_iam_policy.recordings_upload.arn
}

output "presign_policy_arn" {
  description = "IAM policy ARN for R02 api presign role"
  value       = aws_iam_policy.recordings_presign.arn
}
