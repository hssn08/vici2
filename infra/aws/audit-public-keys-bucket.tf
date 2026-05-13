# infra/aws/audit-public-keys-bucket.tf
# S3 bucket for vici2 audit signing public keys.
# Retention: validity_end + 7y so old attestations remain verifiable after key retirement.
# Object Lock Compliance so no key can be deleted during the retention window.

variable "public_keys_bucket_name" {
  description = "S3 bucket name for vici2 audit public keys"
  type        = string
  default     = "vici2-audit-public-keys"
}

resource "aws_s3_bucket" "audit_public_keys" {
  bucket        = var.public_keys_bucket_name
  force_destroy = false
  tags = {
    Project   = "vici2"
    Component = "C03-audit-immutability"
    ManagedBy = "terraform"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_public_keys" {
  bucket = aws_s3_bucket.audit_public_keys.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.audit_attestation_retention_days # same 7y as attestations
    }
  }
}

resource "aws_s3_bucket_versioning" "audit_public_keys" {
  bucket = aws_s3_bucket.audit_public_keys.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "audit_public_keys" {
  bucket                  = aws_s3_bucket.audit_public_keys.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "audit_public_keys_bucket_name" {
  value = aws_s3_bucket.audit_public_keys.id
}
