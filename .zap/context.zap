<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!--
  .zap/context.zap — OWASP ZAP authentication context for vici2 staging scan.

  Configures ZAP to authenticate as a dedicated test agent account so the
  scanner sees authenticated surfaces (agent UI, call controls, etc.).

  Prerequisites:
    - Staging environment has a dedicated ZAP test agent account
    - Credentials stored in GitHub secrets: ZAP_AGENT_USERNAME, ZAP_AGENT_PASSWORD
    - Account has role=agent (not admin) to limit blast radius

  To enable in security-scan.yml, uncomment:
    context_file: .zap/context.zap
    auth_username: ${{ secrets.ZAP_AGENT_USERNAME }}
    auth_password: ${{ secrets.ZAP_AGENT_PASSWORD }}

  This file is committed as a template. Update TARGET_URL to your staging URL.
-->
<configuration>
  <context>
    <name>vici2-staging</name>
    <desc>vici2 staging environment authentication context</desc>
    <inscope>true</inscope>
    <incregexes>https://staging\.vici2\.example\.com.*</incregexes>
    <excregexes>https://staging\.vici2\.example\.com/api/auth/logout.*</excregexes>
    <authentication>
      <type>2</type>
      <!-- HTTP form-based authentication against /api/auth/login -->
      <strategy>
        <loginUrl>https://staging.vici2.example.com/api/auth/login</loginUrl>
        <usernameParameter>email</usernameParameter>
        <passwordParameter>password</passwordParameter>
        <loginRequestData>{"email":"{%username%}","password":"{%password%}"}</loginRequestData>
      </strategy>
      <loggedin_regex>\Q"role"\E</loggedin_regex>
      <loggedout_regex>\Q"error":"Unauthorized"\E</loggedout_regex>
    </authentication>
    <users>
      <user>
        <id>1</id>
        <name>zap-agent</name>
        <credentials>
          <username>{ZAP_AGENT_USERNAME}</username>
          <password>{ZAP_AGENT_PASSWORD}</password>
        </credentials>
        <enabled>true</enabled>
      </user>
    </users>
  </context>
</configuration>
