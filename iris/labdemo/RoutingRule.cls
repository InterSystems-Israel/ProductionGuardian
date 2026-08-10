/// Routing rule for the "Lab Router" Business Process.
///   ADT^A01 → Cloud API, via the HL7ToPID DTL (admit — always has a full PID segment)
///   All others → discarded (logged as unrouted by Lab Router)
///
/// `target` is a production item NAME, and the item names carry spaces. They are the
/// join key with the findings API — see the header of Production.cls.
Class ProductionGuardian.LabDemo.RoutingRule Extends Ens.Rule.Definition
{

Parameter RuleAssistClass = "EnsLib.HL7.MsgRouter.RuleAssist";

XData RuleDefinition [ XMLNamespace = "http://www.intersystems.com/rule" ]
{
<ruleDefinition alias="" context="EnsLib.HL7.MsgRouter.RoutingEngine" production="ProductionGuardian.LabDemo.Production">
  <ruleSet name="" effectiveBegin="" effectiveEnd="">

    <!-- ADT^A01 admit notifications: extract PID and upsert patient demographics -->
    <rule name="Route ADT A01">
      <constraint name="msgClass" value="EnsLib.HL7.Message"/>
      <constraint name="docCategory" value="2.5"/>
      <constraint name="docName" value="ADT_A01"/>
      <when condition="1">
        <send transform="ProductionGuardian.LabDemo.Transform.HL7ToPID" target="Cloud API"></send>
        <return/>
      </when>
    </rule>

  </ruleSet>
</ruleDefinition>
}

}
