locals {
  availability_zone = coalesce(var.availability_zone, "${var.aws_region}a")
  web_ingress = merge(
    { "http-acme" = { cidr = "0.0.0.0/0", port = 80 } },
    { for cidr in var.allowed_https_cidrs : "https:${cidr}" => { cidr = cidr, port = 443 } }
  )
}

resource "aws_vpc" "preview" {
  cidr_block           = "10.48.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_subnet" "core" {
  vpc_id                  = aws_vpc.preview.id
  cidr_block              = "10.48.1.0/24"
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-core" }
}

resource "aws_internet_gateway" "preview" {
  vpc_id = aws_vpc.preview.id
  tags   = { Name = var.name }
}

resource "aws_route_table" "core" {
  vpc_id = aws_vpc.preview.id
  tags   = { Name = "${var.name}-core" }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.core.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.preview.id
}

resource "aws_route_table_association" "core" {
  subnet_id      = aws_subnet.core.id
  route_table_id = aws_route_table.core.id
}

resource "aws_security_group" "core" {
  name        = "${var.name}-core"
  description = "Preview core: HTTP/HTTPS only; administration through SSM"
  vpc_id      = aws_vpc.preview.id
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = local.web_ingress
  security_group_id = aws_security_group.core.id
  cidr_ipv4         = each.value.cidr
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = "tcp"
  description       = each.value.port == 80 ? "ACME HTTP challenge; reverse proxy must redirect other requests" : "Explicitly allowed preview HTTPS clients"
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.core.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Host package repositories, SSM, S3, logs and configured HTTPS APIs"
}

# Attach the EIP before boot, so package installation does not race public-IP
# association. This is the sole ENI; no automatic secondary public IP is used.
resource "aws_network_interface" "core" {
  subnet_id       = aws_subnet.core.id
  security_groups = [aws_security_group.core.id]
  tags            = { Name = "${var.name}-core" }
}

resource "aws_eip" "core" {
  domain            = "vpc"
  network_interface = aws_network_interface.core.id
  depends_on        = [aws_internet_gateway.preview]
  tags              = { Name = var.name }
}
