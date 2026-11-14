import type { BruRequest } from "./bru.js";

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Troca variáveis do Bruno ({{nome}}) por propriedades/variáveis do JMeter. */
export function bruVarsToJmeter(s: string, csvColumns: string[]): string {
  return s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => {
    if (name === "correlationId") return "${__P(correlationId)}-${__threadNum}";
    if (name === "baseApi" || name === "baseUrl") return "";
    if (csvColumns.includes(name)) return "${" + name + "}";
    return "${__P(" + name + ")}";
  });
}

export interface JmxOptions { csvColumns: string[]; expectedStatus?: string }

/** Gera um plano .jmx parametrizado por propriedades (-J): host, protocol, port, threads, rampSec, durationSec, token, massaCsv. */
export function generateJmx(req: BruRequest, opts: JmxOptions): string {
  const url = new URL(req.url.replace(/\{\{\s*(baseApi|baseUrl)\s*\}\}/, "http://placeholder"), "http://placeholder");
  const path = bruVarsToJmeter(decodeURI(url.pathname) + url.search, opts.csvColumns);
  const headers: [string, string][] = Object.entries(req.headers).map(([k, v]) => [k, bruVarsToJmeter(v, opts.csvColumns)]);
  if (!headers.some(([k]) => k.toLowerCase() === "x-correlation-id")) headers.push(["x-correlation-id", "${__P(correlationId)}-${__threadNum}"]);
  if (req.bearer) headers.push(["Authorization", "Bearer ${__P(token)}"]);
  if (req.body && !headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json"]);
  const body = req.body ? bruVarsToJmeter(req.body, opts.csvColumns) : "";
  const label = `${req.method} ${url.pathname}`;

  const headerXml = headers.map(([k, v]) => `
            <elementProp name="${x(k)}" elementType="Header">
              <stringProp name="Header.name">${x(k)}</stringProp>
              <stringProp name="Header.value">${x(v)}</stringProp>
            </elementProp>`).join("");

  const csv = opts.csvColumns.length ? `
        <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="Massa do usuário" enabled="true">
          <stringProp name="filename">\${__P(massaCsv)}</stringProp>
          <stringProp name="fileEncoding">UTF-8</stringProp>
          <stringProp name="variableNames">${x(opts.csvColumns.join(","))}</stringProp>
          <boolProp name="ignoreFirstLine">true</boolProp>
          <stringProp name="delimiter">,</stringProp>
          <boolProp name="quotedData">false</boolProp>
          <boolProp name="recycle">true</boolProp>
          <boolProp name="stopThread">false</boolProp>
          <stringProp name="shareMode">shareMode.all</stringProp>
        </CSVDataSet>
        <hashTree/>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Gerado pelo Rastro a partir de "${x(req.name)}". Revise e aprove junto com o cenário. -->
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Rastro · ${x(req.name)}" enabled="true">
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Usuários" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <intProp name="LoopController.loops">-1</intProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">\${__P(threads,10)}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">\${__P(rampSec,30)}</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">\${__P(durationSec,300)}</stringProp>
        <stringProp name="ThreadGroup.delay">0</stringProp>
        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
      </ThreadGroup>
      <hashTree>
        <ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="Conexão com a API" enabled="true">
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" enabled="true">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
          <stringProp name="HTTPSampler.domain">\${__P(host)}</stringProp>
          <stringProp name="HTTPSampler.port">\${__P(port,)}</stringProp>
          <stringProp name="HTTPSampler.protocol">\${__P(protocol,https)}</stringProp>
          <stringProp name="HTTPSampler.connect_timeout">5000</stringProp>
          <stringProp name="HTTPSampler.response_timeout">30000</stringProp>
        </ConfigTestElement>
        <hashTree/>${csv}
        <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="Headers" enabled="true">
          <collectionProp name="HeaderManager.headers">${headerXml}
          </collectionProp>
        </HeaderManager>
        <hashTree/>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${x(label)}" enabled="true">
          <boolProp name="HTTPSampler.postBodyRaw">${body ? "true" : "false"}</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">${body ? `
              <elementProp name="" elementType="HTTPArgument">
                <boolProp name="HTTPArgument.always_encode">false</boolProp>
                <stringProp name="Argument.value">${x(body)}</stringProp>
                <stringProp name="Argument.metadata">=</stringProp>
              </elementProp>` : ""}
            </collectionProp>
          </elementProp>
          <stringProp name="HTTPSampler.path">${x(path)}</stringProp>
          <stringProp name="HTTPSampler.method">${req.method}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
        </HTTPSamplerProxy>
        <hashTree>
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Status esperado" enabled="true">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="49">\${__P(expectedStatus,${x(opts.expectedStatus ?? "2\\d\\d")})}</stringProp>
            </collectionProp>
            <stringProp name="Assertion.custom_message"></stringProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">1</intProp>
          </ResponseAssertion>
          <hashTree/>
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
}
